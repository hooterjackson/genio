/** Pure promotion and eligibility rules for the governed V3 evidence graph. */

export type EvidenceAuthorityV3 =
  | "primary_track_credit"
  | "official_track_credit"
  | "specialist_track_credit"
  | "trusted_editorial_container"
  | "secondary_database"
  | "catalog_metadata"
  | "unknown";

export type EvidenceScopeV3 =
  | "exact_recording"
  | "exact_release_all_tracks"
  | "release_unspecified_tracks"
  | "recording_family";

export type EvidenceAxisV3 =
  | "genre"
  | "scene"
  | "geography"
  | "language"
  | "theme"
  | "mood"
  | "activity"
  | "similarity"
  | "editorial_ranking"
  | "artist_catalogue"
  | "factual_relationship";

export interface GovernedSourceV3 {
  readonly id: string;
  readonly url: string;
  readonly provenanceRoot: string;
  readonly authority: EvidenceAuthorityV3;
  readonly accessMethod: "hosted_web_search" | "structured_adapter" | "public_api" | "owner_import" | "manual_entry";
  readonly status: "active" | "stale" | "takedown" | "revoked";
  readonly approvalState: "pending" | "approved" | "rejected";
  readonly licenseState: "reusable" | "permission_recorded" | "unknown" | "prohibited";
  readonly licenseVersion: string | null;
  readonly termsVersion: string | null;
  readonly attribution: string | null;
  readonly cachePolicy: "no_store" | "metadata_only" | "excerpt_only" | "full_document_permitted";
  readonly retentionPolicy: "run_only" | "ninety_days" | "durable_public_corpus" | "license_term";
  readonly freshnessPolicy: "immutable_revision" | "revalidate_30d" | "revalidate_90d";
  readonly freshnessExpiresAt: string | null;
  readonly contentHash: string;
  readonly sourceRevision: string;
  readonly retrievedAt: string;
}

export interface EvidenceAssertionV3 {
  readonly id: string;
  readonly recordingId: string;
  readonly subjectEntityId: string;
  readonly relationship: string;
  readonly claimAxis: EvidenceAxisV3;
  readonly supportedValues: readonly string[];
  readonly polarity: "supports" | "disputes";
  readonly scope: EvidenceScopeV3;
  readonly source: GovernedSourceV3;
  readonly extractionMethod: "human" | "structured_adapter" | "hosted_search" | "model" | "owner_import";
  readonly reviewerState: "approved" | "unreviewed" | "rejected";
  readonly identityConfidence: number;
  readonly roleSpecificity: "exact" | "generic";
  /** Required before a release-level credit may propagate to a track. */
  readonly explicitAllTracksStatement: boolean;
  readonly releaseEditionId: string | null;
  readonly enumeratedRecordingIds: readonly string[];
  readonly supersededByAssertionId: string | null;
}

export type EvidencePromotionStateV3 =
  | "verified"
  | "corroborated"
  | "review_required"
  | "quarantined"
  | "disputed"
  | "revoked";

export interface EvidencePromotionDecisionV3 {
  readonly assertionId: string;
  readonly state: EvidencePromotionStateV3;
  readonly eligibleForMembership: boolean;
  readonly reasons: readonly string[];
}

const HIGH_AUTHORITY = new Set<EvidenceAuthorityV3>([
  "primary_track_credit", "official_track_credit", "specialist_track_credit",
]);
const MEDIUM_AUTHORITY = new Set<EvidenceAuthorityV3>([
  "trusted_editorial_container", "secondary_database",
]);

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceGovernanceReasons(source: GovernedSourceV3): string[] {
  const reasons: string[] = [];
  if (source.status === "takedown" || source.status === "revoked") reasons.push("source_revoked");
  else if (source.status !== "active") reasons.push("source_revalidation_required");
  if (source.approvalState !== "approved") reasons.push("source_policy_not_approved");
  if (source.licenseState !== "reusable" && source.licenseState !== "permission_recorded") {
    reasons.push("source_reuse_not_authorized");
  }
  if (!source.licenseVersion?.trim()) reasons.push("license_version_missing");
  if (!source.termsVersion?.trim()) reasons.push("terms_version_missing");
  if (!source.attribution?.trim()) reasons.push("attribution_missing");
  if (source.cachePolicy !== "excerpt_only" && source.cachePolicy !== "full_document_permitted") {
    reasons.push("cache_policy_incompatible");
  }
  if (source.retentionPolicy !== "durable_public_corpus" && source.retentionPolicy !== "license_term") {
    reasons.push("retention_policy_incompatible");
  }
  if (source.freshnessPolicy === "immutable_revision") {
    if (source.freshnessExpiresAt !== null) reasons.push("freshness_policy_invalid");
  } else {
    const expiry = source.freshnessExpiresAt ? new Date(source.freshnessExpiresAt) : null;
    if (!expiry || !Number.isFinite(expiry.getTime()) || expiry <= new Date()) {
      reasons.push("source_revalidation_required");
    }
  }
  if (!source.provenanceRoot.trim() || normalized(source.provenanceRoot) === "unknown") reasons.push("provenance_root_missing");
  if (!/^[a-f0-9]{64}$/u.test(source.contentHash)) reasons.push("source_content_hash_invalid");
  if (!source.sourceRevision.trim()) reasons.push("source_revision_missing");
  if (source.sourceRevision !== source.contentHash) reasons.push("source_revision_hash_mismatch");
  try {
    if (new URL(source.url).protocol !== "https:") reasons.push("source_url_not_https");
  } catch {
    reasons.push("source_url_invalid");
  }
  return reasons;
}

function scopeReasons(assertion: EvidenceAssertionV3): string[] {
  const reasons: string[] = [];
  if (assertion.scope === "release_unspecified_tracks") reasons.push("album_credit_track_scope_unspecified");
  if (assertion.scope === "recording_family") reasons.push("recording_family_not_exact_credit_scope");
  if (assertion.scope === "exact_release_all_tracks") {
    if (!assertion.explicitAllTracksStatement) reasons.push("all_tracks_statement_missing");
    if (!assertion.releaseEditionId?.trim()) reasons.push("exact_release_edition_missing");
    if (!assertion.enumeratedRecordingIds.includes(assertion.recordingId)) reasons.push("recording_not_on_enumerated_edition");
  }
  if (assertion.roleSpecificity !== "exact" && assertion.claimAxis === "factual_relationship") {
    reasons.push("factual_role_not_specific");
  }
  return reasons;
}

/** Evaluate one assertion without pretending another source corroborates it. */
export function evaluateEvidenceAssertionV3(assertion: EvidenceAssertionV3): EvidencePromotionDecisionV3 {
  const reasons = [...sourceGovernanceReasons(assertion.source), ...scopeReasons(assertion)];
  if (assertion.supersededByAssertionId) reasons.push("assertion_superseded");
  if (assertion.reviewerState === "rejected") reasons.push("reviewer_rejected");
  if (!Number.isFinite(assertion.identityConfidence) || assertion.identityConfidence < 0.9) {
    reasons.push("recording_identity_below_threshold");
  }
  if (assertion.polarity === "disputes") {
    return { assertionId: assertion.id, state: "disputed", eligibleForMembership: false, reasons: [...reasons, "negative_assertion"] };
  }
  if (assertion.source.status === "takedown" || assertion.source.status === "revoked" || assertion.supersededByAssertionId) {
    return { assertionId: assertion.id, state: "revoked", eligibleForMembership: false, reasons };
  }
  if (assertion.extractionMethod === "model" || assertion.extractionMethod === "owner_import") {
    return {
      assertionId: assertion.id,
      state: "quarantined",
      eligibleForMembership: false,
      reasons: [...reasons, "untrusted_extraction_requires_review"],
    };
  }
  if (assertion.reviewerState !== "approved") reasons.push("human_promotion_required");
  if (reasons.length > 0) {
    return { assertionId: assertion.id, state: "review_required", eligibleForMembership: false, reasons };
  }
  if (HIGH_AUTHORITY.has(assertion.source.authority)) {
    return { assertionId: assertion.id, state: "verified", eligibleForMembership: true, reasons: [] };
  }
  // Medium sources are not self-corroborating. The set-level evaluator may
  // promote them after it observes a second independent root.
  if (MEDIUM_AUTHORITY.has(assertion.source.authority)) {
    return {
      assertionId: assertion.id,
      state: "review_required",
      eligibleForMembership: false,
      reasons: ["independent_corroboration_required"],
    };
  }
  return {
    assertionId: assertion.id,
    state: "review_required",
    eligibleForMembership: false,
    reasons: ["source_authority_below_threshold"],
  };
}

function assertionClaimKey(assertion: EvidenceAssertionV3): string {
  return [
    assertion.recordingId,
    assertion.subjectEntityId,
    assertion.claimAxis,
    normalized(assertion.relationship),
    ...assertion.supportedValues.map(normalized).sort(),
  ].join("\u0000");
}

/**
 * Promote medium assertions only when two independent provenance roots make
 * the same exact-recording claim. A dispute blocks every positive assertion
 * for that claim until reviewed.
 */
export function promoteEvidenceAssertionsV3(
  assertions: readonly EvidenceAssertionV3[],
): EvidencePromotionDecisionV3[] {
  const base = new Map(assertions.map((assertion) => [assertion.id, evaluateEvidenceAssertionV3(assertion)]));
  const byClaim = new Map<string, EvidenceAssertionV3[]>();
  for (const assertion of assertions) {
    const key = assertionClaimKey(assertion);
    byClaim.set(key, [...(byClaim.get(key) ?? []), assertion]);
  }
  for (const claimAssertions of byClaim.values()) {
    const hasDispute = claimAssertions.some(({ polarity }) => polarity === "disputes");
    if (hasDispute) {
      for (const assertion of claimAssertions.filter(({ polarity }) => polarity === "supports")) {
        base.set(assertion.id, {
          assertionId: assertion.id,
          state: "disputed",
          eligibleForMembership: false,
          reasons: ["claim_has_unresolved_dispute"],
        });
      }
      continue;
    }
    const eligibleMedium = claimAssertions.filter((assertion) => {
      const decision = base.get(assertion.id)!;
      return MEDIUM_AUTHORITY.has(assertion.source.authority)
        && decision.reasons.length === 1
        && decision.reasons[0] === "independent_corroboration_required";
    });
    const roots = new Set(eligibleMedium.map(({ source }) => normalized(source.provenanceRoot)).filter(Boolean));
    if (roots.size >= 2) {
      for (const assertion of eligibleMedium) {
        base.set(assertion.id, {
          assertionId: assertion.id,
          state: "corroborated",
          eligibleForMembership: true,
          reasons: [],
        });
      }
    }
  }
  return assertions.map(({ id }) => base.get(id)!);
}

export interface EvidenceRequirementV3 {
  readonly id: string;
  readonly axis: EvidenceAxisV3;
  readonly acceptedValues: readonly string[];
}

export interface CandidateEvidenceEligibilityV3 {
  readonly eligible: boolean;
  readonly missingRequirementIds: readonly string[];
  readonly supportingAssertionIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

/** Catalog identity is necessary but never counts as relationship evidence. */
export function evaluateCandidateEvidenceEligibilityV3(input: {
  recordingId: string;
  hasPlayableCatalogIdentity: boolean;
  requirements: readonly EvidenceRequirementV3[];
  assertions: readonly EvidenceAssertionV3[];
}): CandidateEvidenceEligibilityV3 {
  const promoted = promoteEvidenceAssertionsV3(input.assertions);
  const decisionById = new Map(promoted.map((decision) => [decision.assertionId, decision]));
  const eligibleAssertions = input.assertions.filter((assertion) => (
    assertion.recordingId === input.recordingId
    && decisionById.get(assertion.id)?.eligibleForMembership === true
  ));
  const missingRequirementIds = input.requirements.filter((requirement) => !eligibleAssertions.some((assertion) => (
    assertion.claimAxis === requirement.axis
    && (requirement.acceptedValues.length === 0
      || assertion.supportedValues.some((value) => requirement.acceptedValues.map(normalized).includes(normalized(value))))
  ))).map(({ id }) => id);
  const reasonCodes: string[] = [];
  if (!input.hasPlayableCatalogIdentity) reasonCodes.push("playable_catalog_identity_missing");
  if (missingRequirementIds.length > 0) reasonCodes.push("evidence_requirement_missing");
  return {
    eligible: input.hasPlayableCatalogIdentity && missingRequirementIds.length === 0,
    missingRequirementIds,
    supportingAssertionIds: eligibleAssertions.map(({ id }) => id),
    reasonCodes,
  };
}
