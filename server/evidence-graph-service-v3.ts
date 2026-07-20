import { createHash, randomUUID } from "node:crypto";
import type { EvidenceAuthorityV3 } from "./evidence-graph-policy.ts";

export const EVIDENCE_GRAPH_PIPELINE_V3 = "corpus_first_v3";
export const EVIDENCE_GRAPH_POLICY_V3 = "corpus_first_v3_policy_v1";

export type EvidenceGraphLicenseStateV3 =
  | "reusable"
  | "permission_recorded"
  | "unknown"
  | "prohibited";

export type EvidenceGraphSourceAccessMethodV3 =
  | "hosted_web_search"
  | "structured_adapter"
  | "public_api"
  | "owner_import"
  | "manual_entry";

export type EvidenceGraphCachePolicyV3 =
  | "no_store"
  | "metadata_only"
  | "excerpt_only"
  | "full_document_permitted";

export type EvidenceGraphRetentionPolicyV3 =
  | "run_only"
  | "ninety_days"
  | "durable_public_corpus"
  | "license_term";

export type EvidenceGraphFreshnessPolicyV3 =
  | "immutable_revision"
  | "revalidate_30d"
  | "revalidate_90d";

export interface EvidenceGraphSourcePolicyV3 {
  schemaVersion: 1;
  approvalState: "approved" | "rejected" | "pending";
  authority: EvidenceAuthorityV3;
  accessMethod: EvidenceGraphSourceAccessMethodV3;
  licenseState: EvidenceGraphLicenseStateV3;
  licenseVersion: string | null;
  termsVersion: string | null;
  attribution: string | null;
  cachePolicy: EvidenceGraphCachePolicyV3;
  retentionPolicy: EvidenceGraphRetentionPolicyV3;
  freshnessPolicy: EvidenceGraphFreshnessPolicyV3;
  freshnessExpiresAt: string | null;
  sourceRevision: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason?: string | null;
  takedownReason?: string | null;
  takenDownAt?: string | null;
}

export interface EvidenceGraphSourceDocumentV3 {
  id: string;
  url: string;
  contentHash: string;
  title: string;
  sourceClass: string;
  provenanceRoot: string;
  accessMethod: EvidenceGraphSourceAccessMethodV3;
  approvalState: EvidenceGraphSourcePolicyV3["approvalState"];
  authority: EvidenceAuthorityV3;
  licenseState: EvidenceGraphLicenseStateV3;
  licenseVersion: string | null;
  termsVersion: string | null;
  attribution: string | null;
  cachePolicy: EvidenceGraphCachePolicyV3;
  retentionPolicy: EvidenceGraphRetentionPolicyV3;
  freshnessPolicy: EvidenceGraphFreshnessPolicyV3;
  freshnessExpiresAt: Date | null;
  sourceRevision: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  takedownReason: string | null;
  takenDownAt: Date | null;
  status: string;
  retrievedAt: Date;
  lastVerifiedAt: Date | null;
  metadataJson: Record<string, unknown>;
}

export interface EvidenceGraphObservationV3 {
  id: string;
  observationKey: string;
  sourceDocumentId: string;
  subjectEntityId: string | null;
  recordingId: string | null;
  releaseId: string | null;
  predicate: string;
  objectJson: Record<string, unknown>;
  creditScope: string | null;
  supportExcerpt: string;
  confidence: number;
  status: "quarantined" | "rejected" | "promoted";
  pipelineVersion: string;
  policyVersion: string;
  observedAt: Date;
}

export interface EvidenceGraphAssertionV3 {
  id: string;
  assertionKey: string;
  subjectEntityId: string | null;
  recordingId: string | null;
  releaseId: string | null;
  predicate: string;
  objectJson: Record<string, unknown>;
  evidenceTier: string;
  status: "active" | "superseded" | "retracted";
  validFrom: Date;
  validTo: Date | null;
  promotedAt: Date;
  retractedAt: Date | null;
  promotedBy: string;
  metadataJson: Record<string, unknown>;
}

export interface EvidenceGraphAssertionBundleV3 {
  assertion: EvidenceGraphAssertionV3;
  evidence: Array<{
    observation: EvidenceGraphObservationV3;
    source: EvidenceGraphSourceDocumentV3;
  }>;
}

export interface EvidenceGraphCatalogIdentityV3 {
  id: string;
  recordingId: string;
  provider: string;
  storefront: string;
  catalogId: string;
  isPreferred: boolean;
  isAvailable: boolean;
  identityConfidence: number;
}

export interface EvidenceGraphSnapshotV3 {
  id: string;
  parentSnapshotId: string | null;
  status: "building" | "locked" | "superseded";
  contentHash: string | null;
  assertionCount: number;
  catalogIdentityCount: number;
  lockedAt: Date | null;
}

export interface AppendObservationInputV3 {
  id?: string;
  observationKey?: string;
  sourceDocumentId: string;
  subjectEntityId?: string | null;
  recordingId?: string | null;
  releaseId?: string | null;
  predicate: string;
  objectJson: Record<string, unknown>;
  creditScope?: string | null;
  supportExcerpt: string;
  confidence: number;
  pipelineVersion: string;
  policyVersion: string;
  observedAt?: Date;
}

export interface InsertAssertionInputV3 {
  id: string;
  assertionKey: string;
  subjectEntityId: string | null;
  recordingId: string | null;
  releaseId: string | null;
  predicate: string;
  objectJson: Record<string, unknown>;
  evidenceTier: string;
  promotedBy: string;
  metadataJson: Record<string, unknown>;
  validFrom: Date;
}

export interface EvidenceGraphUnitOfWorkV3 {
  getSourceDocuments(ids: readonly string[]): Promise<EvidenceGraphSourceDocumentV3[]>;
  setSourceGovernance(input: {
    sourceDocumentId: string;
    status: string;
    policy: EvidenceGraphSourcePolicyV3;
    lastVerifiedAt: Date;
  }): Promise<EvidenceGraphSourceDocumentV3>;
  insertObservation(input: Required<Pick<AppendObservationInputV3,
    "id" | "observationKey" | "sourceDocumentId" | "predicate" | "objectJson" |
    "supportExcerpt" | "confidence" | "pipelineVersion" | "policyVersion" | "observedAt"
  >> & Pick<AppendObservationInputV3, "subjectEntityId" | "recordingId" | "releaseId" | "creditScope">): Promise<EvidenceGraphObservationV3>;
  getObservations(ids: readonly string[]): Promise<EvidenceGraphObservationV3[]>;
  insertAssertion(input: InsertAssertionInputV3): Promise<EvidenceGraphAssertionV3>;
  linkAssertionEvidence(assertionId: string, observationIds: readonly string[]): Promise<void>;
  transitionObservations(
    ids: readonly string[],
    from: EvidenceGraphObservationV3["status"],
    to: EvidenceGraphObservationV3["status"],
  ): Promise<void>;
  getAssertion(id: string): Promise<EvidenceGraphAssertionV3 | null>;
  transitionAssertion(input: {
    assertionId: string;
    from: readonly EvidenceGraphAssertionV3["status"][];
    to: EvidenceGraphAssertionV3["status"];
    at: Date;
  }): Promise<void>;
  listActiveAssertionBundles(): Promise<EvidenceGraphAssertionBundleV3[]>;
  listAvailableCatalogIdentities(recordingIds: readonly string[]): Promise<EvidenceGraphCatalogIdentityV3[]>;
  acquireSnapshotHashLock(contentHash: string): Promise<void>;
  findLockedSnapshotByHash(contentHash: string): Promise<EvidenceGraphSnapshotV3 | null>;
  insertBuildingSnapshot(input: { id: string; parentSnapshotId: string | null }): Promise<void>;
  addSnapshotAssertions(snapshotId: string, assertionIds: readonly string[]): Promise<void>;
  addSnapshotCatalogIdentities(snapshotId: string, catalogIdentityIds: readonly string[]): Promise<void>;
  lockSnapshot(input: {
    snapshotId: string;
    contentHash: string;
    assertionCount: number;
    catalogIdentityCount: number;
    lockedAt: Date;
  }): Promise<EvidenceGraphSnapshotV3>;
}

export interface EvidenceGraphRepositoryV3 {
  transaction<T>(callback: (unit: EvidenceGraphUnitOfWorkV3) => Promise<T>): Promise<T>;
}

export class EvidenceGraphLifecycleErrorV3 extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceGraphLifecycleErrorV3";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvidenceGraphLifecycleErrorV3("invalid_input", `${name} is required`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new EvidenceGraphLifecycleErrorV3("invalid_input", `${name} exceeds ${maximum} characters`);
  }
  return result;
}

function freshnessExpiry(
  policy: EvidenceGraphFreshnessPolicyV3,
  approvedAt: Date,
): Date | null {
  if (policy === "immutable_revision") return null;
  const days = policy === "revalidate_30d" ? 30 : 90;
  return new Date(approvedAt.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function sourcePolicyV3(source: EvidenceGraphSourceDocumentV3): EvidenceGraphSourcePolicyV3 | null {
  return {
    schemaVersion: 1,
    approvalState: source.approvalState,
    authority: source.authority,
    accessMethod: source.accessMethod,
    licenseState: source.licenseState,
    licenseVersion: source.licenseVersion,
    termsVersion: source.termsVersion,
    attribution: source.attribution,
    cachePolicy: source.cachePolicy,
    retentionPolicy: source.retentionPolicy,
    freshnessPolicy: source.freshnessPolicy,
    freshnessExpiresAt: source.freshnessExpiresAt?.toISOString() ?? null,
    sourceRevision: source.sourceRevision,
    approvedBy: source.approvedBy,
    approvedAt: source.approvedAt?.toISOString() ?? null,
    takedownReason: source.takedownReason,
    takenDownAt: source.takenDownAt?.toISOString() ?? null,
  };
}

export function sourceIsApprovedForReuseV3(
  source: EvidenceGraphSourceDocumentV3,
  now: Date = new Date(),
): boolean {
  const policy = sourcePolicyV3(source);
  if (!policy || source.status !== "active" || policy.approvalState !== "approved") return false;
  if (policy.licenseState !== "reusable" && policy.licenseState !== "permission_recorded") return false;
  if (!policy.licenseVersion?.trim() || !policy.termsVersion?.trim() || !policy.attribution?.trim()
    || !policy.sourceRevision.trim() || !policy.approvedBy?.trim() || !policy.approvedAt) return false;
  if (policy.cachePolicy !== "excerpt_only" && policy.cachePolicy !== "full_document_permitted") return false;
  if (policy.retentionPolicy !== "durable_public_corpus" && policy.retentionPolicy !== "license_term") return false;
  if (policy.freshnessPolicy === "immutable_revision") {
    if (policy.freshnessExpiresAt !== null) return false;
  } else {
    const expiresAt = policy.freshnessExpiresAt ? new Date(policy.freshnessExpiresAt) : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return false;
  }
  if (!source.provenanceRoot.trim() || normalized(source.provenanceRoot) === "unknown") return false;
  if (!/^[a-f0-9]{64}$/u.test(source.contentHash)) return false;
  if (source.sourceRevision !== source.contentHash) return false;
  try {
    return new URL(source.url).protocol === "https:";
  } catch {
    return false;
  }
}

export interface TrackScopeDecisionV3 {
  eligible: boolean;
  reasonCodes: string[];
}

/**
 * Exact-track membership is fail-closed. Release propagation is permitted only
 * when the observation names the exact edition, carries an explicit all-track
 * statement, and enumerates the recording. Generic album/family scope is never
 * upgraded merely because a title happens to appear on a release.
 */
export function exactTrackScopeDecisionV3(observation: EvidenceGraphObservationV3): TrackScopeDecisionV3 {
  const graph = isObject(observation.objectJson.graph) ? observation.objectJson.graph : {};
  // The dedicated schema-14 column is the authoritative scope classification;
  // object metadata only supplies propagation details and a compatibility
  // fallback for the earliest V3 observations.
  const scope = observation.creditScope ?? (typeof graph.scope === "string" ? graph.scope : null);
  const reasons: string[] = [];
  if (!observation.recordingId) reasons.push("recording_id_missing");
  if (scope === "exact_recording") return { eligible: reasons.length === 0, reasonCodes: reasons };
  if (scope === "exact_release_all_tracks") {
    if (graph.explicitAllTracksStatement !== true) reasons.push("all_tracks_statement_missing");
    if (typeof graph.releaseEditionId !== "string" || !graph.releaseEditionId.trim()) reasons.push("exact_release_edition_missing");
    const recordingIds = Array.isArray(graph.enumeratedRecordingIds)
      ? graph.enumeratedRecordingIds.filter((value): value is string => typeof value === "string")
      : [];
    if (!observation.recordingId || !recordingIds.includes(observation.recordingId)) {
      reasons.push("recording_not_on_enumerated_edition");
    }
    return { eligible: reasons.length === 0, reasonCodes: reasons };
  }
  if (scope === "release_unspecified_tracks" || scope === "album") {
    reasons.push("album_credit_track_scope_unspecified");
  } else if (scope === "recording_family") {
    reasons.push("recording_family_not_exact_credit_scope");
  } else {
    reasons.push("exact_track_scope_missing");
  }
  return { eligible: false, reasonCodes: reasons };
}

function observationClaimKey(observation: EvidenceGraphObservationV3): string {
  const graph = isObject(observation.objectJson.graph) ? observation.objectJson.graph : {};
  return sha256({
    subjectEntityId: observation.subjectEntityId,
    recordingId: observation.recordingId,
    releaseId: observation.releaseId,
    predicate: normalized(observation.predicate),
    relationship: typeof graph.relationship === "string" ? normalized(graph.relationship) : "",
    supportedValues: Array.isArray(graph.supportedValues)
      ? graph.supportedValues.filter((value): value is string => typeof value === "string").map(normalized).sort()
      : [],
  });
}

function observationPolarity(observation: EvidenceGraphObservationV3): "supports" | "disputes" {
  const graph = isObject(observation.objectJson.graph) ? observation.objectJson.graph : {};
  return graph.polarity === "disputes" ? "disputes" : "supports";
}

function isHighAuthority(authority: EvidenceAuthorityV3): boolean {
  return ["primary_track_credit", "official_track_credit", "specialist_track_credit"].includes(authority);
}

function isMediumAuthority(authority: EvidenceAuthorityV3): boolean {
  return ["trusted_editorial_container", "secondary_database"].includes(authority);
}

function activeEvidenceRoots(bundle: EvidenceGraphAssertionBundleV3): Set<string> {
  return new Set(bundle.evidence
    .filter(({ observation, source }) => (
      observation.pipelineVersion === EVIDENCE_GRAPH_PIPELINE_V3
      && observation.policyVersion === EVIDENCE_GRAPH_POLICY_V3
      && exactTrackScopeDecisionV3(observation).eligible
      && sourceIsApprovedForReuseV3(source)
    ))
    .map(({ source }) => normalized(source.provenanceRoot))
    .filter(Boolean));
}

function assertionHasCurrentSupport(bundle: EvidenceGraphAssertionBundleV3): boolean {
  if (bundle.assertion.status !== "active") return false;
  if (!["verified", "corroborated"].includes(bundle.assertion.evidenceTier)) return false;
  const eligibleEvidence = bundle.evidence.filter(({ observation, source }) => (
    observation.pipelineVersion === EVIDENCE_GRAPH_PIPELINE_V3
    && observation.policyVersion === EVIDENCE_GRAPH_POLICY_V3
    && exactTrackScopeDecisionV3(observation).eligible
    && sourceIsApprovedForReuseV3(source)
  ));
  if (bundle.assertion.evidenceTier === "verified") {
    return eligibleEvidence.some(({ source }) => {
      const policy = sourcePolicyV3(source);
      return Boolean(policy && isHighAuthority(policy.authority));
    });
  }
  return activeEvidenceRoots(bundle).size >= 2;
}

function assertionClaimKey(assertion: EvidenceGraphAssertionV3): string {
  const graph = isObject(assertion.objectJson.graph) ? assertion.objectJson.graph : {};
  return sha256({
    subjectEntityId: assertion.subjectEntityId,
    recordingId: assertion.recordingId,
    releaseId: assertion.releaseId,
    predicate: normalized(assertion.predicate),
    relationship: typeof graph.relationship === "string" ? normalized(graph.relationship) : "",
    supportedValues: Array.isArray(graph.supportedValues)
      ? graph.supportedValues.filter((value): value is string => typeof value === "string").map(normalized).sort()
      : [],
  });
}

function assertionPolarity(assertion: EvidenceGraphAssertionV3): "supports" | "disputes" {
  const graph = isObject(assertion.objectJson.graph) ? assertion.objectJson.graph : {};
  return graph.polarity === "disputes" ? "disputes" : "supports";
}

function eligibleSnapshotBundles(bundles: readonly EvidenceGraphAssertionBundleV3[]): EvidenceGraphAssertionBundleV3[] {
  const disputedClaims = new Set(bundles
    .filter(({ assertion }) => assertion.status === "active" && assertionPolarity(assertion) === "disputes")
    .map(({ assertion }) => assertionClaimKey(assertion)));
  return bundles.filter((bundle) => (
    assertionPolarity(bundle.assertion) === "supports"
    && !disputedClaims.has(assertionClaimKey(bundle.assertion))
    && assertionHasCurrentSupport(bundle)
  ));
}

function ensureSameClaim(observations: readonly EvidenceGraphObservationV3[]): void {
  if (new Set(observations.map(observationClaimKey)).size !== 1) {
    throw new EvidenceGraphLifecycleErrorV3(
      "claim_mismatch",
      "Promotion evidence must support the same exact-recording claim",
    );
  }
}

function ensureV3PromotionObservation(observation: EvidenceGraphObservationV3): void {
  if (observation.pipelineVersion !== EVIDENCE_GRAPH_PIPELINE_V3
    || observation.policyVersion !== EVIDENCE_GRAPH_POLICY_V3) {
    throw new EvidenceGraphLifecycleErrorV3(
      "historical_pipeline_quarantine",
      "Historical V1/V2 observations remain quarantined; create a reviewed V3 observation instead",
    );
  }
  if (observation.status !== "quarantined") {
    throw new EvidenceGraphLifecycleErrorV3("observation_not_quarantined", "Only quarantined observations may be promoted");
  }
  const scope = exactTrackScopeDecisionV3(observation);
  if (!scope.eligible) {
    throw new EvidenceGraphLifecycleErrorV3(scope.reasonCodes[0] ?? "track_scope_ineligible", "Observation lacks exact track scope");
  }
}

function sourceById(sources: readonly EvidenceGraphSourceDocumentV3[]): Map<string, EvidenceGraphSourceDocumentV3> {
  return new Map(sources.map((source) => [source.id, source]));
}

function promotionTier(
  observations: readonly EvidenceGraphObservationV3[],
  sources: readonly EvidenceGraphSourceDocumentV3[],
): "verified" | "corroborated" {
  const lookup = sourceById(sources);
  const approved = observations.map((observation) => lookup.get(observation.sourceDocumentId))
    .filter((source): source is EvidenceGraphSourceDocumentV3 => Boolean(source))
    .filter((source) => sourceIsApprovedForReuseV3(source));
  if (approved.length !== observations.length) {
    throw new EvidenceGraphLifecycleErrorV3("source_policy_not_approved", "Every promotion source requires an approved reuse policy");
  }
  if (approved.some((source) => {
    const policy = sourcePolicyV3(source);
    return Boolean(policy && isHighAuthority(policy.authority));
  })) return "verified";
  if (approved.some((source) => {
    const policy = sourcePolicyV3(source);
    return !policy || !isMediumAuthority(policy.authority);
  })) {
    throw new EvidenceGraphLifecycleErrorV3(
      "source_authority_below_threshold",
      "Only governed medium-authority sources may establish corroboration",
    );
  }
  const roots = new Set(approved.map(({ provenanceRoot }) => normalized(provenanceRoot)).filter(Boolean));
  if (roots.size < 2) {
    throw new EvidenceGraphLifecycleErrorV3(
      "independent_corroboration_required",
      "Corroboration requires at least two independent provenance roots",
    );
  }
  return "corroborated";
}

function lifecycleAssertionInput(input: {
  target: EvidenceGraphAssertionV3;
  kind: "retraction";
  actor: string;
  reason: string;
  at: Date;
}): InsertAssertionInputV3 {
  const assertionKey = sha256({
    lifecycle: input.kind,
    targetAssertionKey: input.target.assertionKey,
    actor: normalized(input.actor),
    reason: input.reason,
  });
  return {
    id: randomUUID(),
    assertionKey,
    subjectEntityId: input.target.subjectEntityId,
    recordingId: input.target.recordingId,
    releaseId: input.target.releaseId,
    predicate: `lifecycle:${input.kind}`,
    objectJson: {
      lifecycle: input.kind,
      targetAssertionId: input.target.id,
      reason: input.reason,
    },
    evidenceTier: input.kind,
    promotedBy: input.actor,
    metadataJson: { nonMembershipLifecycleEvent: true },
    validFrom: input.at,
  };
}

export class EvidenceGraphServiceV3 {
  constructor(
    private readonly repository: EvidenceGraphRepositoryV3,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async approveSourcePolicy(input: {
    sourceDocumentId: string;
    authority: EvidenceAuthorityV3;
    accessMethod: EvidenceGraphSourceAccessMethodV3;
    licenseState: "reusable" | "permission_recorded";
    licenseVersion: string;
    termsVersion: string;
    attribution: string;
    cachePolicy: "excerpt_only" | "full_document_permitted";
    retentionPolicy: "durable_public_corpus" | "license_term";
    freshnessPolicy: EvidenceGraphFreshnessPolicyV3;
    sourceRevision: string;
    approvedBy: string;
  }): Promise<EvidenceGraphSourceDocumentV3> {
    return this.repository.transaction(async (unit) => {
      const [source] = await unit.getSourceDocuments([input.sourceDocumentId]);
      if (!source) throw new EvidenceGraphLifecycleErrorV3("source_not_found", "Source document was not found");
      const approvedAt = this.now();
      if (source.approvalState === "approved") {
        if (sourceIsApprovedForReuseV3(source, approvedAt)) return source;
        throw new EvidenceGraphLifecycleErrorV3(
          "source_policy_terminal",
          "Approved source policy cannot be rewritten; capture a successor source document",
        );
      }
      if (source.approvalState !== "pending" || source.status !== "active") {
        throw new EvidenceGraphLifecycleErrorV3("source_policy_terminal", "Source is not pending governance review");
      }
      if (input.accessMethod !== source.accessMethod) {
        throw new EvidenceGraphLifecycleErrorV3("source_access_method_mismatch", "Access method must match the captured source revision");
      }
      if (boundedText(input.sourceRevision, "sourceRevision", 160) !== source.sourceRevision
        || source.sourceRevision !== source.contentHash) {
        throw new EvidenceGraphLifecycleErrorV3("source_revision_mismatch", "Source revision must match the captured source hash");
      }
      const policy: EvidenceGraphSourcePolicyV3 = {
        schemaVersion: 1,
        approvalState: "approved",
        authority: input.authority,
        accessMethod: input.accessMethod,
        licenseState: input.licenseState,
        licenseVersion: boundedText(input.licenseVersion, "licenseVersion", 160),
        termsVersion: boundedText(input.termsVersion, "termsVersion", 160),
        attribution: boundedText(input.attribution, "attribution", 1_000),
        cachePolicy: input.cachePolicy,
        retentionPolicy: input.retentionPolicy,
        freshnessPolicy: input.freshnessPolicy,
        freshnessExpiresAt: freshnessExpiry(input.freshnessPolicy, approvedAt)?.toISOString() ?? null,
        sourceRevision: source.sourceRevision,
        approvedBy: boundedText(input.approvedBy, "approvedBy", 120),
        approvedAt: approvedAt.toISOString(),
      };
      const candidate: EvidenceGraphSourceDocumentV3 = {
        ...source,
        status: "active",
        approvalState: policy.approvalState,
        authority: policy.authority,
        licenseState: policy.licenseState,
        licenseVersion: policy.licenseVersion,
        termsVersion: policy.termsVersion,
        attribution: policy.attribution,
        cachePolicy: policy.cachePolicy,
        retentionPolicy: policy.retentionPolicy,
        freshnessPolicy: policy.freshnessPolicy,
        freshnessExpiresAt: policy.freshnessExpiresAt ? new Date(policy.freshnessExpiresAt) : null,
        approvedBy: policy.approvedBy,
        approvedAt,
      };
      if (!sourceIsApprovedForReuseV3(candidate, approvedAt)) {
        throw new EvidenceGraphLifecycleErrorV3("source_governance_invalid", "Source does not meet the V3 governance floor");
      }
      return unit.setSourceGovernance({
        sourceDocumentId: source.id,
        status: "active",
        policy,
        lastVerifiedAt: approvedAt,
      });
    });
  }

  async appendObservation(input: AppendObservationInputV3): Promise<EvidenceGraphObservationV3> {
    const subjectCount = [input.subjectEntityId, input.recordingId, input.releaseId].filter(Boolean).length;
    if (subjectCount === 0) throw new EvidenceGraphLifecycleErrorV3("observation_subject_missing", "Observation needs a subject");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new EvidenceGraphLifecycleErrorV3("confidence_invalid", "Observation confidence must be between 0 and 1");
    }
    const id = input.id ?? randomUUID();
    const observedAt = input.observedAt ?? this.now();
    const canonical = {
      sourceDocumentId: input.sourceDocumentId,
      subjectEntityId: input.subjectEntityId ?? null,
      recordingId: input.recordingId ?? null,
      releaseId: input.releaseId ?? null,
      predicate: boundedText(input.predicate, "predicate", 160),
      objectJson: input.objectJson,
      creditScope: input.creditScope ?? null,
      supportExcerpt: boundedText(input.supportExcerpt, "supportExcerpt", 1000),
      pipelineVersion: boundedText(input.pipelineVersion, "pipelineVersion", 48),
      policyVersion: boundedText(input.policyVersion, "policyVersion", 80),
    };
    return this.repository.transaction(async (unit) => {
      const [source] = await unit.getSourceDocuments([canonical.sourceDocumentId]);
      if (!source) throw new EvidenceGraphLifecycleErrorV3("source_not_found", "Source document was not found");
      return unit.insertObservation({
        id,
        observationKey: input.observationKey ?? sha256(canonical),
        ...canonical,
        confidence: input.confidence,
        observedAt,
      });
    });
  }

  async promoteObservations(input: {
    observationIds: readonly string[];
    promotedBy: string;
  }): Promise<EvidenceGraphAssertionV3> {
    const ids = [...new Set(input.observationIds)];
    if (ids.length === 0) throw new EvidenceGraphLifecycleErrorV3("evidence_missing", "Promotion requires evidence observations");
    return this.repository.transaction(async (unit) => {
      const observations = await unit.getObservations(ids);
      if (observations.length !== ids.length) throw new EvidenceGraphLifecycleErrorV3("observation_not_found", "One or more observations were not found");
      observations.forEach(ensureV3PromotionObservation);
      ensureSameClaim(observations);
      if (observations.some((observation) => observationPolarity(observation) !== "supports")) {
        throw new EvidenceGraphLifecycleErrorV3("dispute_requires_lifecycle", "Negative observations must use disputeAssertion");
      }
      const sources = await unit.getSourceDocuments(observations.map(({ sourceDocumentId }) => sourceDocumentId));
      const tier = promotionTier(observations, sources);
      const first = observations[0]!;
      const actor = boundedText(input.promotedBy, "promotedBy", 120);
      const assertionKey = sha256({ claim: observationClaimKey(first), observations: observations.map(({ observationKey }) => observationKey).sort() });
      const assertion = await unit.insertAssertion({
        id: randomUUID(),
        assertionKey,
        subjectEntityId: first.subjectEntityId,
        recordingId: first.recordingId,
        releaseId: first.releaseId,
        predicate: first.predicate,
        objectJson: first.objectJson,
        evidenceTier: tier,
        promotedBy: actor,
        metadataJson: {
          provenanceRoots: [...new Set(sources.map(({ provenanceRoot }) => normalized(provenanceRoot)))].sort(),
          observationKeys: observations.map(({ observationKey }) => observationKey).sort(),
        },
        validFrom: this.now(),
      });
      await unit.linkAssertionEvidence(assertion.id, observations.map(({ id }) => id));
      await unit.transitionObservations(observations.map(({ id }) => id), "quarantined", "promoted");
      return assertion;
    });
  }

  async rejectObservation(input: {
    observationId: string;
    rejectedBy: string;
    reason: string;
  }): Promise<EvidenceGraphObservationV3> {
    return this.repository.transaction(async (unit) => {
      const [observation] = await unit.getObservations([input.observationId]);
      if (!observation) {
        throw new EvidenceGraphLifecycleErrorV3("observation_not_found", "Observation was not found");
      }
      if (observation.status !== "quarantined") {
        throw new EvidenceGraphLifecycleErrorV3(
          "observation_not_quarantined",
          "Only a quarantined observation may be rejected",
        );
      }
      boundedText(input.rejectedBy, "rejectedBy", 120);
      boundedText(input.reason, "reason", 500);
      await unit.transitionObservations([observation.id], "quarantined", "rejected");
      return { ...observation, status: "rejected" };
    });
  }

  async disputeAssertion(input: {
    assertionId: string;
    observationId: string;
    promotedBy: string;
  }): Promise<EvidenceGraphAssertionV3> {
    return this.repository.transaction(async (unit) => {
      const target = await unit.getAssertion(input.assertionId);
      if (!target || target.status !== "active") {
        throw new EvidenceGraphLifecycleErrorV3("assertion_not_active", "Only an active assertion may be disputed");
      }
      const [observation] = await unit.getObservations([input.observationId]);
      if (!observation) throw new EvidenceGraphLifecycleErrorV3("observation_not_found", "Dispute observation was not found");
      ensureV3PromotionObservation(observation);
      if (observationPolarity(observation) !== "disputes" || observationClaimKey(observation) !== assertionClaimKey(target)) {
        throw new EvidenceGraphLifecycleErrorV3("dispute_claim_mismatch", "Dispute must target the same exact-recording claim");
      }
      const [source] = await unit.getSourceDocuments([observation.sourceDocumentId]);
      if (!source || !sourceIsApprovedForReuseV3(source)) {
        throw new EvidenceGraphLifecycleErrorV3("source_policy_not_approved", "Dispute source requires an approved reuse policy");
      }
      const actor = boundedText(input.promotedBy, "promotedBy", 120);
      const disputedAt = this.now();
      const dispute = await unit.insertAssertion({
        id: randomUUID(),
        assertionKey: sha256({ lifecycle: "dispute", target: target.assertionKey, observation: observation.observationKey }),
        subjectEntityId: target.subjectEntityId,
        recordingId: target.recordingId,
        releaseId: target.releaseId,
        predicate: target.predicate,
        objectJson: observation.objectJson,
        evidenceTier: "disputed",
        promotedBy: actor,
        metadataJson: { disputesAssertionId: target.id, nonMembershipLifecycleEvent: true },
        validFrom: disputedAt,
      });
      await unit.linkAssertionEvidence(dispute.id, [observation.id]);
      await unit.transitionObservations([observation.id], "quarantined", "promoted");
      await unit.transitionAssertion({ assertionId: target.id, from: ["active"], to: "superseded", at: disputedAt });
      return dispute;
    });
  }

  async retractAssertion(input: {
    assertionId: string;
    promotedBy: string;
    reason: string;
  }): Promise<EvidenceGraphAssertionV3> {
    return this.repository.transaction(async (unit) => {
      const target = await unit.getAssertion(input.assertionId);
      if (!target || (target.status !== "active" && target.status !== "superseded")) {
        throw new EvidenceGraphLifecycleErrorV3("assertion_not_retractable", "Assertion is already retracted or missing");
      }
      const at = this.now();
      const lifecycle = await unit.insertAssertion(lifecycleAssertionInput({
        target,
        kind: "retraction",
        actor: boundedText(input.promotedBy, "promotedBy", 120),
        reason: boundedText(input.reason, "reason", 500),
        at,
      }));
      await unit.transitionAssertion({ assertionId: target.id, from: [target.status], to: "retracted", at });
      return lifecycle;
    });
  }

  async takeDownSource(input: {
    sourceDocumentId: string;
    promotedBy: string;
    reason: string;
  }): Promise<{ retractedAssertionIds: string[]; retainedAssertionIds: string[] }> {
    return this.repository.transaction(async (unit) => {
      const [source] = await unit.getSourceDocuments([input.sourceDocumentId]);
      if (!source) throw new EvidenceGraphLifecycleErrorV3("source_not_found", "Source document was not found");
      const at = this.now();
      const existingPolicy = sourcePolicyV3(source);
      const policy: EvidenceGraphSourcePolicyV3 = {
        schemaVersion: 1,
        approvalState: existingPolicy?.approvalState ?? "pending",
        authority: existingPolicy?.authority ?? "unknown",
        accessMethod: source.accessMethod,
        licenseState: existingPolicy?.licenseState ?? "unknown",
        licenseVersion: existingPolicy?.licenseVersion ?? null,
        termsVersion: existingPolicy?.termsVersion ?? null,
        attribution: existingPolicy?.attribution ?? null,
        cachePolicy: existingPolicy?.cachePolicy ?? source.cachePolicy,
        retentionPolicy: existingPolicy?.retentionPolicy ?? source.retentionPolicy,
        freshnessPolicy: existingPolicy?.freshnessPolicy ?? source.freshnessPolicy,
        freshnessExpiresAt: existingPolicy?.freshnessExpiresAt ?? source.freshnessExpiresAt?.toISOString() ?? null,
        sourceRevision: existingPolicy?.sourceRevision ?? "unknown",
        approvedBy: existingPolicy?.approvedBy ?? null,
        approvedAt: existingPolicy?.approvedAt ?? null,
        takedownReason: boundedText(input.reason, "reason", 500),
        takenDownAt: at.toISOString(),
      };
      await unit.setSourceGovernance({
        sourceDocumentId: source.id,
        status: "takedown",
        policy,
        lastVerifiedAt: at,
      });
      const bundles = await unit.listActiveAssertionBundles();
      const affected = bundles.filter(({ evidence }) => evidence.some(({ source: evidenceSource }) => evidenceSource.id === source.id));
      const retractedAssertionIds: string[] = [];
      const retainedAssertionIds: string[] = [];
      for (const bundle of affected) {
        if (assertionHasCurrentSupport(bundle)) {
          retainedAssertionIds.push(bundle.assertion.id);
          continue;
        }
        const lifecycle = lifecycleAssertionInput({
          target: bundle.assertion,
          kind: "retraction",
          actor: boundedText(input.promotedBy, "promotedBy", 120),
          reason: `source_takedown:${policy.takedownReason}`,
          at,
        });
        await unit.insertAssertion(lifecycle);
        await unit.transitionAssertion({ assertionId: bundle.assertion.id, from: ["active"], to: "retracted", at });
        retractedAssertionIds.push(bundle.assertion.id);
      }
      return { retractedAssertionIds, retainedAssertionIds };
    });
  }

  async createLockedSnapshot(input: { parentSnapshotId?: string | null } = {}): Promise<EvidenceGraphSnapshotV3> {
    return this.repository.transaction(async (unit) => {
      const bundles = eligibleSnapshotBundles(await unit.listActiveAssertionBundles());
      const assertionIds = bundles.map(({ assertion }) => assertion.id).sort();
      const recordingIds = [...new Set(bundles.map(({ assertion }) => assertion.recordingId).filter((id): id is string => Boolean(id)))].sort();
      const catalogIdentities = (await unit.listAvailableCatalogIdentities(recordingIds))
        .filter(({ isAvailable, identityConfidence }) => isAvailable && identityConfidence >= 0.9)
        .sort((left, right) => left.id.localeCompare(right.id));
      const catalogIdentityIds = catalogIdentities.map(({ id }) => id);
      const contentHash = sha256({
        parentSnapshotId: input.parentSnapshotId ?? null,
        assertionIds,
        catalogIdentityIds,
      });
      await unit.acquireSnapshotHashLock(contentHash);
      const existing = await unit.findLockedSnapshotByHash(contentHash);
      if (existing) return existing;
      const snapshotId = randomUUID();
      await unit.insertBuildingSnapshot({ id: snapshotId, parentSnapshotId: input.parentSnapshotId ?? null });
      await unit.addSnapshotAssertions(snapshotId, assertionIds);
      await unit.addSnapshotCatalogIdentities(snapshotId, catalogIdentityIds);
      return unit.lockSnapshot({
        snapshotId,
        contentHash,
        assertionCount: assertionIds.length,
        catalogIdentityCount: catalogIdentityIds.length,
        lockedAt: this.now(),
      });
    });
  }
}
