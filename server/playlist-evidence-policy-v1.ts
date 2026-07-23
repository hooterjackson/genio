/**
 * Versioned evidence semantics for canonical playlist contracts.
 *
 * Evidence grades describe both a source class and the entailment that source
 * is allowed to make. They therefore do not form a sound total order. This
 * policy deliberately records only the two within-family strength relations
 * we can defend:
 *
 * - direct track-scoped evidence (structured metadata or a track-specific
 *   editorial assertion) is stronger than indirect trusted-container
 *   association for a claim that permits both grades;
 * - a primary factual source is stronger than an independent secondary
 *   factual source for a claim that permits both grades.
 *
 * All other cross-family comparisons are incomparable and fail closed. The
 * permitted-grade allowlist remains the claim-specific entailment boundary.
 */

export const GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION =
  "governed_evidence_v2" as const;
export const SHADOW_PLAYLIST_EVIDENCE_POLICY_VERSION =
  "selection_plan_evidence_projection_v2" as const;
export const PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION =
  "evidence_strength_partial_order_v1" as const;

export type PlaylistEvidenceGradeV1 =
  | "authoritative_structured_metadata"
  | "trusted_scoped_container"
  | "track_specific_editorial_assertion"
  | "primary_source"
  | "independent_secondary_source"
  | "model_derived_lead";

const EVIDENCE_GRADES = Object.freeze([
  "authoritative_structured_metadata",
  "trusted_scoped_container",
  "track_specific_editorial_assertion",
  "primary_source",
  "independent_secondary_source",
  "model_derived_lead",
] as const satisfies readonly PlaylistEvidenceGradeV1[]);

const KNOWN_EVIDENCE_GRADES = new Set<string>(EVIDENCE_GRADES);

const SUPPORTED_CONTRACT_EVIDENCE_POLICIES = new Set<string>([
  GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION,
  SHADOW_PLAYLIST_EVIDENCE_POLICY_VERSION,
]);

/**
 * Reflexive transitive closure of the intentionally small partial order.
 * Model-derived leads are listed only so untrusted runtime values can be
 * recognized and rejected explicitly; they never satisfy an obligation.
 */
const SATISFIES_MINIMUM = Object.freeze({
  authoritative_structured_metadata: [
    "authoritative_structured_metadata",
    "trusted_scoped_container",
  ],
  trusted_scoped_container: [
    "trusted_scoped_container",
  ],
  track_specific_editorial_assertion: [
    "track_specific_editorial_assertion",
    "trusted_scoped_container",
  ],
  primary_source: [
    "primary_source",
    "independent_secondary_source",
  ],
  independent_secondary_source: [
    "independent_secondary_source",
  ],
  model_derived_lead: [],
} as const satisfies Readonly<
  Record<PlaylistEvidenceGradeV1, readonly PlaylistEvidenceGradeV1[]>
>);

export interface PlaylistEvidenceObligationLikeV1 {
  readonly required: boolean;
  readonly minimumGrade: PlaylistEvidenceGradeV1 | null;
  readonly permittedGrades: readonly PlaylistEvidenceGradeV1[];
}

export function isPlaylistEvidenceGradeV1(
  value: unknown,
): value is PlaylistEvidenceGradeV1 {
  return typeof value === "string" && KNOWN_EVIDENCE_GRADES.has(value);
}

export function isSupportedPlaylistEvidencePolicyVersionV1(
  value: unknown,
): value is
  | typeof GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION
  | typeof SHADOW_PLAYLIST_EVIDENCE_POLICY_VERSION {
  return typeof value === "string" && SUPPORTED_CONTRACT_EVIDENCE_POLICIES.has(value);
}

/**
 * Whether `grade` is at least `minimumGrade` under the documented partial
 * order. Incomparable and unrecognized pairs return false.
 */
export function playlistEvidenceGradeMeetsMinimumV1(input: {
  readonly grade: unknown;
  readonly minimumGrade: unknown;
  readonly strengthPolicyVersion: unknown;
}): boolean {
  if (input.strengthPolicyVersion !== PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION
    || !isPlaylistEvidenceGradeV1(input.grade)
    || !isPlaylistEvidenceGradeV1(input.minimumGrade)
    || input.grade === "model_derived_lead"
    || input.minimumGrade === "model_derived_lead") {
    return false;
  }
  const satisfied = SATISFIES_MINIMUM[input.grade] as readonly PlaylistEvidenceGradeV1[];
  return satisfied.includes(input.minimumGrade);
}

/**
 * Complete selection-grade check for one assessment. Missing, unrecognized,
 * unpermitted, incomparable, and model-derived grades all fail closed.
 */
export function playlistEvidenceGradeSatisfiesObligationV1(input: {
  readonly grade: unknown;
  readonly obligation: PlaylistEvidenceObligationLikeV1;
  readonly evidencePolicyVersion: unknown;
  readonly strengthPolicyVersion: unknown;
}): boolean {
  if (!isSupportedPlaylistEvidencePolicyVersionV1(input.evidencePolicyVersion)
    || input.strengthPolicyVersion !== PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION
    || !isPlaylistEvidenceGradeV1(input.grade)
    || input.grade === "model_derived_lead"
    || !input.obligation.permittedGrades.includes(input.grade)) {
    return false;
  }
  if (input.obligation.minimumGrade === null) return true;
  return playlistEvidenceGradeMeetsMinimumV1({
    grade: input.grade,
    minimumGrade: input.obligation.minimumGrade,
    strengthPolicyVersion: input.strengthPolicyVersion,
  });
}

/**
 * Selects a deterministic qualifying grade without pretending incomparable
 * evidence families have a global "strongest" member. `null` means no
 * supplied grade can satisfy the immutable obligation.
 */
export function selectQualifyingPlaylistEvidenceGradeV1(input: {
  readonly grades: readonly unknown[];
  readonly obligation: PlaylistEvidenceObligationLikeV1;
  readonly evidencePolicyVersion: unknown;
  readonly strengthPolicyVersion: unknown;
}): PlaylistEvidenceGradeV1 | null {
  const unique = [...new Set(input.grades.filter(isPlaylistEvidenceGradeV1))]
    .sort((left, right) => left.localeCompare(right));
  return unique.find((grade) => playlistEvidenceGradeSatisfiesObligationV1({
    grade,
    obligation: input.obligation,
    evidencePolicyVersion: input.evidencePolicyVersion,
    strengthPolicyVersion: input.strengthPolicyVersion,
  })) ?? null;
}
