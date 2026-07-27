import {
  PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  resolveMusicConceptV1,
  type MusicConceptKindV1,
  type MusicConceptResolutionV1,
} from "./music-concept-registry-v1.ts";
import {
  GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION,
  PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
  isPlaylistEvidenceGradeV1,
  playlistEvidenceGradeSatisfiesObligationV1,
  type PlaylistEvidenceGradeV1,
} from "./playlist-evidence-policy-v1.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const PLAYLIST_CONTRACT_SCHEMA_VERSION = 1 as const;
export const PLAYLIST_CONTRACT_COMPILER_VERSION = "playlist_contract_compiler_v1" as const;
export const PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION =
  GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION;
export const PLAYLIST_CONTRACT_QUESTION_TEMPLATE_VERSION = "guidance_decision_v3" as const;
export const PLAYLIST_CONTRACT_CATALOG_POLICY_VERSION = "catalog_policy_v1" as const;

export type PlaylistContractClauseKindV1 =
  | "membership"
  | "factual_relationship"
  | "suitability"
  | "exclusion"
  | "catalog_version"
  | "quota_diversity"
  | "ranking_preference";

export type PlaylistContractClauseScopeV1 = "track" | "playlist";
export type PlaylistContractClauseHardnessV1 = "hard" | "soft";
export type PlaylistContractClauseOperatorV1 =
  | "require"
  | "prefer"
  | "exclude"
  | "allow"
  | "balance"
  | "limit";
export type PlaylistContractUnknownPolicyV1 = "defer" | "reject" | "allow";
export type PlaylistContractClauseSourceV1 = "prompt" | "guidance" | "system_default" | "migration";
export type PlaylistContractTriStateV1 = "pass" | "fail" | "unknown";

export type PlaylistContractEvidenceGradeV1 = PlaylistEvidenceGradeV1;

export interface PlaylistContractVersionSnapshotV1 {
  readonly compiler: string;
  readonly ontology: string;
  readonly evidencePolicy: string;
  readonly questionTemplates: string;
  readonly catalogPolicy: string;
}

export interface PlaylistContractSourceSpanV1 {
  readonly start: number;
  readonly end: number;
}

export interface PlaylistContractClauseSourceDetailV1 {
  readonly provenance: PlaylistContractClauseSourceV1;
  readonly text: string;
  readonly spans: readonly PlaylistContractSourceSpanV1[];
}

export interface PlaylistContractEvidenceObligationV1 {
  readonly required: boolean;
  readonly claim: string;
  readonly minimumGrade: PlaylistContractEvidenceGradeV1 | null;
  readonly permittedGrades: readonly PlaylistContractEvidenceGradeV1[];
}

export interface PlaylistContractConceptInputV1 {
  readonly text: string;
  readonly expectedKind?: MusicConceptKindV1 | null;
  readonly selectedConceptId?: string | null;
}

export interface PlaylistContractClauseDraftV1 {
  readonly id: string;
  readonly kind: PlaylistContractClauseKindV1;
  readonly scope: PlaylistContractClauseScopeV1;
  readonly hardness: PlaylistContractClauseHardnessV1;
  readonly axis: string;
  readonly operator: PlaylistContractClauseOperatorV1;
  readonly values?: readonly string[];
  readonly conceptInputs?: readonly PlaylistContractConceptInputV1[];
  readonly source: Omit<PlaylistContractClauseSourceDetailV1, "spans"> & {
    readonly spans?: readonly PlaylistContractSourceSpanV1[];
  };
  readonly evidence?: Partial<PlaylistContractEvidenceObligationV1>;
  readonly unknownPolicy?: PlaylistContractUnknownPolicyV1;
}

export interface PlaylistContractClauseV1 {
  readonly id: string;
  readonly kind: PlaylistContractClauseKindV1;
  readonly scope: PlaylistContractClauseScopeV1;
  readonly hardness: PlaylistContractClauseHardnessV1;
  readonly axis: string;
  readonly operator: PlaylistContractClauseOperatorV1;
  readonly values: readonly string[];
  readonly concepts: readonly MusicConceptResolutionV1[];
  readonly source: PlaylistContractClauseSourceDetailV1;
  readonly evidence: PlaylistContractEvidenceObligationV1;
  readonly unknownPolicy: PlaylistContractUnknownPolicyV1;
  readonly changePolicy: "user_revision_only" | "system_ranking_only";
}

export type PlaylistPredicateV1 =
  | {
    readonly op: "clause";
    readonly clauseId: string;
  }
  | {
    readonly op: "all" | "any";
    readonly children: readonly PlaylistPredicateV1[];
  }
  | {
    readonly op: "not";
    readonly child: PlaylistPredicateV1;
  }
  | {
    readonly op: "except";
    readonly base: PlaylistPredicateV1;
    readonly exceptions: readonly PlaylistPredicateV1[];
  }
  | {
    readonly op: "alternative";
    readonly choices: readonly {
      readonly id: string;
      readonly priority: number;
      readonly predicate: PlaylistPredicateV1;
    }[];
  };

export interface PlaylistQuotaConstraintV1 {
  readonly id: string;
  readonly clauseId: string;
  readonly predicate: PlaylistPredicateV1;
  readonly minimumCount: number | null;
  readonly maximumCount: number | null;
  readonly minimumRatio: number | null;
  readonly maximumRatio: number | null;
}

export interface PlaylistSequencingObjectiveV1 {
  readonly id: string;
  readonly clauseId: string;
  readonly dimension: string;
  readonly direction: "ascending" | "descending" | "smooth" | "contrast" | "editorial";
  readonly weight: number;
  readonly priority: number;
}

export interface PlaylistContractQualityPolicyV1 {
  readonly centralSuitabilityClauseIds: readonly string[];
  readonly minimumPassRatio: number;
  readonly maximumUnknownRatio: number;
  readonly zeroKnownFailures: true;
}

export interface PlaylistContractAnswerLineageV1 {
  readonly questionSetHash: string;
  readonly questionId: string;
  readonly answerHash: string;
}

export interface PlaylistContractExecutionDirectivesV1 {
  readonly fixedContainer: {
    readonly kind: "album" | "playlist";
    readonly name: string;
    readonly artistName: string | null;
    readonly membershipClauseId: string;
  } | null;
  readonly similarity: {
    readonly seedArtists: readonly string[];
    readonly excludedArtists: readonly string[];
    readonly rankingClauseId: string;
    readonly exactArtistExclusionClauseIds: readonly string[];
  } | null;
  /**
   * Exact named-artist exclusions which are independent of a similarity seed.
   * This marker is the sole authority for treating the bound artist clauses
   * as closed-world catalog identity checks.
   */
  readonly exactArtistIdentityExclusions?: {
    readonly bindings: readonly {
      readonly clauseId: string;
      readonly catalogArtistId: string;
      readonly displayName: string;
      readonly storefront: string;
    }[];
  } | null;
}

export interface PlaylistContractDraftV1 {
  readonly contractId: string;
  readonly rawPrompt: string;
  readonly requestedTrackCount: number;
  readonly locale: string;
  readonly storefront: string;
  readonly versions?: Partial<PlaylistContractVersionSnapshotV1>;
  readonly clauses: readonly PlaylistContractClauseDraftV1[];
  readonly trackPredicate: PlaylistPredicateV1;
  readonly playlistConstraints?: readonly PlaylistQuotaConstraintV1[];
  readonly sequencingObjectives?: readonly PlaylistSequencingObjectiveV1[];
  readonly qualityPolicy?: Partial<PlaylistContractQualityPolicyV1>;
  /** Optional so historical schema-1 contracts remain byte-for-byte verifiable. */
  readonly executionDirectives?: PlaylistContractExecutionDirectivesV1;
}

export interface PlaylistContractRevisionV1 {
  readonly schemaVersion: typeof PLAYLIST_CONTRACT_SCHEMA_VERSION;
  readonly contractId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly parentRevisionId: string | null;
  readonly parentSemanticHash: string | null;
  readonly semanticHash: string;
  readonly versions: PlaylistContractVersionSnapshotV1;
  readonly rawPrompt: string;
  readonly requestedTrackCount: number;
  readonly locale: string;
  readonly storefront: string;
  readonly partialPolicy: "ask";
  readonly clauses: readonly PlaylistContractClauseV1[];
  readonly trackPredicate: PlaylistPredicateV1;
  readonly playlistConstraints: readonly PlaylistQuotaConstraintV1[];
  readonly sequencingObjectives: readonly PlaylistSequencingObjectiveV1[];
  readonly qualityPolicy: PlaylistContractQualityPolicyV1;
  /** Optional so historical schema-1 contracts remain byte-for-byte verifiable. */
  readonly executionDirectives?: PlaylistContractExecutionDirectivesV1;
  readonly answerLineage: readonly PlaylistContractAnswerLineageV1[];
}

export type PlaylistContractPatchOperationV1 =
  | { readonly op: "add_clause"; readonly clause: PlaylistContractClauseDraftV1 }
  | { readonly op: "replace_clause"; readonly clauseId: string; readonly clause: PlaylistContractClauseDraftV1 }
  | { readonly op: "remove_clause"; readonly clauseId: string }
  | { readonly op: "replace_track_predicate"; readonly predicate: PlaylistPredicateV1 }
  | { readonly op: "set_requested_track_count"; readonly count: number }
  | { readonly op: "set_playlist_constraints"; readonly constraints: readonly PlaylistQuotaConstraintV1[] }
  | { readonly op: "set_sequencing_objectives"; readonly objectives: readonly PlaylistSequencingObjectiveV1[] }
  | { readonly op: "set_quality_policy"; readonly policy: PlaylistContractQualityPolicyV1 }
  | {
    readonly op: "set_exact_artist_identity_exclusions";
    readonly directive: {
      readonly bindings: readonly {
        readonly clauseId: string;
        readonly catalogArtistId: string;
        readonly displayName: string;
        readonly storefront: string;
      }[];
    } | null;
  };

export interface PlaylistContractPatchV1 {
  readonly baseRevisionId: string;
  readonly baseSemanticHash: string;
  readonly answerLineage: PlaylistContractAnswerLineageV1;
  readonly operations: readonly PlaylistContractPatchOperationV1[];
}

export interface PlaylistClauseAssessmentV1 {
  /**
   * For positive clauses this is support for the required claim. For an
   * exclusion it is whether the excluded claim matches; the evaluator inverts
   * it into contract-compliance status.
   */
  readonly status: PlaylistContractTriStateV1;
  readonly evidenceGrade?: PlaylistContractEvidenceGradeV1 | null;
  readonly evidenceIds?: readonly string[];
}

export interface PlaylistClauseEvaluationV1 {
  readonly clauseId: string;
  readonly status: PlaylistContractTriStateV1;
  readonly rawStatus: PlaylistContractTriStateV1;
  readonly reason:
    | "supported"
    | "refuted"
    | "unknown"
    | "excluded_match"
    | "excluded_absent"
    | "exclusion_unknown"
    | "insufficient_evidence_grade";
  readonly evidenceGrade: PlaylistContractEvidenceGradeV1 | null;
}

export interface PlaylistPredicateEvaluationV1 {
  readonly status: PlaylistContractTriStateV1;
  readonly eligible: boolean;
  readonly clauses: Readonly<Record<string, PlaylistClauseEvaluationV1>>;
}

export interface PlaylistQuotaEvaluationV1 {
  readonly id: string;
  readonly status: PlaylistContractTriStateV1;
  readonly passCount: number;
  readonly unknownCount: number;
  readonly totalCount: number;
}

export interface PlaylistQualityEvaluationV1 {
  readonly status: PlaylistContractTriStateV1;
  readonly passRatio: number;
  readonly unknownRatio: number;
  readonly failCount: number;
  readonly passCount: number;
  readonly unknownCount: number;
  readonly totalAssessments: number;
}

const TRACK_PREDICATE_KINDS = new Set<PlaylistContractClauseKindV1>([
  "membership",
  "factual_relationship",
  "suitability",
  "exclusion",
  "catalog_version",
]);

const DEFAULT_VERSIONS: PlaylistContractVersionSnapshotV1 = {
  compiler: PLAYLIST_CONTRACT_COMPILER_VERSION,
  ontology: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  evidencePolicy: PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION,
  questionTemplates: PLAYLIST_CONTRACT_QUESTION_TEMPLATE_VERSION,
  catalogPolicy: PLAYLIST_CONTRACT_CATALOG_POLICY_VERSION,
};

function normalizedText(value: string, name: string, maximum = 2_000): string {
  const result = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!result) throw new Error(`empty_${name}`);
  if (result.length > maximum) throw new Error(`${name}_too_long`);
  return result;
}

function normalizedId(value: string, name: string): string {
  const result = normalizedText(value, name, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(result)) throw new Error(`invalid_${name}`);
  return result;
}

function originalPrompt(value: string): string {
  if (!value.trim()) throw new Error("empty_raw_prompt");
  if (value.length > 10_000) throw new Error("raw_prompt_too_long");
  return value;
}

function finiteRatio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid_${name}`);
  return value;
}

function positiveCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error(`invalid_${name}`);
  return value;
}

function nonNegativeCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error(`invalid_${name}`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function copyPlain<T>(value: T): T {
  return structuredClone(value);
}

function defaultEvidence(
  draft: PlaylistContractClauseDraftV1,
): PlaylistContractEvidenceObligationV1 {
  const hardSelection = draft.hardness === "hard" && TRACK_PREDICATE_KINDS.has(draft.kind);
  const permittedByKind: Record<PlaylistContractClauseKindV1, readonly PlaylistContractEvidenceGradeV1[]> = {
    membership: [
      "authoritative_structured_metadata",
      "trusted_scoped_container",
      "track_specific_editorial_assertion",
    ],
    factual_relationship: [
      "primary_source",
      "independent_secondary_source",
    ],
    suitability: ["track_specific_editorial_assertion", "independent_secondary_source"],
    exclusion: [
      "authoritative_structured_metadata",
      "trusted_scoped_container",
      "track_specific_editorial_assertion",
    ],
    catalog_version: ["authoritative_structured_metadata"],
    quota_diversity: ["authoritative_structured_metadata"],
    ranking_preference: [
      "authoritative_structured_metadata",
      "trusted_scoped_container",
      "track_specific_editorial_assertion",
      "independent_secondary_source",
    ],
  };
  const minimumByKind: Record<
    PlaylistContractClauseKindV1,
    PlaylistContractEvidenceGradeV1 | null
  > = {
    // Direct track evidence and track-specific editorial assertions both
    // dominate indirect trusted-container association under the versioned
    // partial-order policy.
    membership: "trusted_scoped_container",
    exclusion: "trusted_scoped_container",
    // These kinds permit genuinely incomparable evidence families. A null
    // minimum means every listed selection-grade route is independently
    // acceptable; the permitted allowlist still gates entailment.
    factual_relationship: null,
    suitability: null,
    ranking_preference: null,
    catalog_version: "authoritative_structured_metadata",
    quota_diversity: "authoritative_structured_metadata",
  };
  const defaultMinimum: PlaylistContractEvidenceGradeV1 | null = hardSelection
    ? minimumByKind[draft.kind]
    : null;
  const required = draft.evidence?.required ?? hardSelection;
  const minimumGrade = draft.evidence?.minimumGrade ?? defaultMinimum;
  const permittedGrades = [...new Set(
    draft.evidence?.permittedGrades ?? permittedByKind[draft.kind],
  )].sort();
  const claim = normalizedText(
    draft.evidence?.claim ?? `${draft.axis}:${draft.operator}`,
    "evidence_claim",
    500,
  );
  if (required && permittedGrades.length === 0) {
    throw new Error("required_evidence_needs_permitted_grade");
  }
  if (hardSelection && !required) {
    throw new Error("hard_selection_clause_requires_evidence");
  }
  if (minimumGrade && !permittedGrades.includes(minimumGrade)) {
    throw new Error("minimum_evidence_grade_not_permitted");
  }
  if (hardSelection && (
    minimumGrade === "model_derived_lead" || permittedGrades.includes("model_derived_lead")
  )) {
    throw new Error("model_lead_cannot_qualify_hard_clause");
  }
  return { required, claim, minimumGrade, permittedGrades };
}

function compileClause(
  draft: PlaylistContractClauseDraftV1,
  rawPrompt: string,
): PlaylistContractClauseV1 {
  const id = normalizedId(draft.id, "clause_id");
  const axis = normalizedText(draft.axis, "clause_axis", 120).toLocaleLowerCase("en-US");
  const values = [...new Set((draft.values ?? []).map((value) => (
    normalizedText(value, "clause_value", 500)
  )))].sort((left, right) => left.localeCompare(right));
  const concepts = (draft.conceptInputs ?? []).map((input) => resolveMusicConceptV1(input));
  const sourceText = normalizedText(draft.source.text, "clause_source", 1_000);
  const spans = (draft.source.spans ?? []).map((span) => {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < 0 || span.end <= span.start) {
      throw new Error("invalid_clause_source_span");
    }
    if (draft.source.provenance === "prompt" && span.end > rawPrompt.length) {
      throw new Error("clause_source_span_out_of_bounds");
    }
    return { start: span.start, end: span.end };
  });
  if ((draft.kind === "exclusion") !== (draft.operator === "exclude")) {
    throw new Error("exclusion_operator_mismatch");
  }
  if (draft.scope === "track" && !TRACK_PREDICATE_KINDS.has(draft.kind)
    && draft.kind !== "ranking_preference") {
    throw new Error("invalid_track_clause_kind");
  }
  if (draft.scope === "playlist" && TRACK_PREDICATE_KINDS.has(draft.kind)
    && draft.kind !== "suitability") {
    throw new Error("invalid_playlist_clause_kind");
  }
  if (draft.hardness === "hard"
    && (draft.kind === "membership" || draft.kind === "exclusion")
    && concepts.some((concept) => concept.status !== "resolved")) {
    throw new Error("hard_clause_requires_resolved_concept");
  }
  if (values.length === 0 && concepts.length === 0) throw new Error("clause_requires_value_or_concept");
  return {
    id,
    kind: draft.kind,
    scope: draft.scope,
    hardness: draft.hardness,
    axis,
    operator: draft.operator,
    values,
    concepts,
    source: {
      provenance: draft.source.provenance,
      text: sourceText,
      spans,
    },
    evidence: defaultEvidence(draft),
    unknownPolicy: draft.unknownPolicy ?? (draft.kind === "exclusion" ? "defer" : "defer"),
    changePolicy: draft.hardness === "hard" ? "user_revision_only" : "system_ranking_only",
  };
}

function normalizePredicate(
  predicate: PlaylistPredicateV1,
  depth = 0,
  counter = { value: 0 },
): PlaylistPredicateV1 {
  if (depth > 24 || ++counter.value > 500) throw new Error("playlist_predicate_too_complex");
  if (predicate.op === "clause") {
    return { op: "clause", clauseId: normalizedId(predicate.clauseId, "predicate_clause_id") };
  }
  if (predicate.op === "not") {
    return { op: "not", child: normalizePredicate(predicate.child, depth + 1, counter) };
  }
  if (predicate.op === "except") {
    if (predicate.exceptions.length === 0) throw new Error("predicate_exceptions_required");
    return {
      op: "except",
      base: normalizePredicate(predicate.base, depth + 1, counter),
      exceptions: predicate.exceptions.map((value) => normalizePredicate(value, depth + 1, counter)),
    };
  }
  if (predicate.op === "alternative") {
    if (predicate.choices.length < 2) throw new Error("predicate_alternatives_required");
    const choices = predicate.choices.map((choice) => {
      if (!Number.isSafeInteger(choice.priority) || choice.priority < 0) {
        throw new Error("invalid_predicate_alternative_priority");
      }
      return {
        id: normalizedId(choice.id, "predicate_alternative_id"),
        priority: choice.priority,
        predicate: normalizePredicate(choice.predicate, depth + 1, counter),
      };
    });
    if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
      throw new Error("duplicate_predicate_alternative_id");
    }
    return { op: "alternative", choices };
  }
  if (predicate.children.length === 0) throw new Error("predicate_children_required");
  return {
    op: predicate.op,
    children: predicate.children.map((value) => normalizePredicate(value, depth + 1, counter)),
  };
}

function predicateClauseIds(predicate: PlaylistPredicateV1, output = new Set<string>()): Set<string> {
  if (predicate.op === "clause") output.add(predicate.clauseId);
  else if (predicate.op === "not") predicateClauseIds(predicate.child, output);
  else if (predicate.op === "except") {
    predicateClauseIds(predicate.base, output);
    predicate.exceptions.forEach((value) => predicateClauseIds(value, output));
  } else if (predicate.op === "alternative") {
    predicate.choices.forEach((choice) => predicateClauseIds(choice.predicate, output));
  } else {
    predicate.children.forEach((value) => predicateClauseIds(value, output));
  }
  return output;
}

function canonicalPredicate(predicate: PlaylistPredicateV1): unknown {
  if (predicate.op === "clause") return predicate;
  if (predicate.op === "not") return { op: predicate.op, child: canonicalPredicate(predicate.child) };
  if (predicate.op === "except") {
    return {
      op: predicate.op,
      base: canonicalPredicate(predicate.base),
      exceptions: predicate.exceptions.map(canonicalPredicate)
        .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    };
  }
  if (predicate.op === "alternative") {
    return {
      op: predicate.op,
      choices: predicate.choices.map((choice) => ({
        id: choice.id,
        priority: choice.priority,
        predicate: canonicalPredicate(choice.predicate),
      })).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
    };
  }
  return {
    op: predicate.op,
    children: predicate.children.map(canonicalPredicate)
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
  };
}

function normalizeQuotaConstraint(value: PlaylistQuotaConstraintV1): PlaylistQuotaConstraintV1 {
  const minimumCount = value.minimumCount === null ? null : nonNegativeCount(value.minimumCount, "quota_minimum_count");
  const maximumCount = value.maximumCount === null ? null : nonNegativeCount(value.maximumCount, "quota_maximum_count");
  const minimumRatio = value.minimumRatio === null ? null : finiteRatio(value.minimumRatio, "quota_minimum_ratio");
  const maximumRatio = value.maximumRatio === null ? null : finiteRatio(value.maximumRatio, "quota_maximum_ratio");
  if (minimumCount !== null && maximumCount !== null && minimumCount > maximumCount) {
    throw new Error("contradictory_quota_counts");
  }
  if (minimumRatio !== null && maximumRatio !== null && minimumRatio > maximumRatio) {
    throw new Error("contradictory_quota_ratios");
  }
  if (minimumCount === null && maximumCount === null && minimumRatio === null && maximumRatio === null) {
    throw new Error("empty_quota_constraint");
  }
  return {
    id: normalizedId(value.id, "quota_id"),
    clauseId: normalizedId(value.clauseId, "quota_clause_id"),
    predicate: normalizePredicate(value.predicate),
    minimumCount,
    maximumCount,
    minimumRatio,
    maximumRatio,
  };
}

function normalizeSequencingObjective(
  value: PlaylistSequencingObjectiveV1,
): PlaylistSequencingObjectiveV1 {
  if (!Number.isFinite(value.weight) || value.weight <= 0 || value.weight > 100) {
    throw new Error("invalid_sequencing_weight");
  }
  if (!Number.isSafeInteger(value.priority) || value.priority < 0 || value.priority > 1_000) {
    throw new Error("invalid_sequencing_priority");
  }
  return {
    id: normalizedId(value.id, "sequencing_id"),
    clauseId: normalizedId(value.clauseId, "sequencing_clause_id"),
    dimension: normalizedText(value.dimension, "sequencing_dimension", 120).toLocaleLowerCase("en-US"),
    direction: value.direction,
    weight: value.weight,
    priority: value.priority,
  };
}

function normalizeQualityPolicy(
  value: Partial<PlaylistContractQualityPolicyV1> | undefined,
  clauses: readonly PlaylistContractClauseV1[],
): PlaylistContractQualityPolicyV1 {
  const centralSuitabilityClauseIds = [...new Set(
    value?.centralSuitabilityClauseIds
      ?? clauses.filter((clause) => clause.kind === "suitability").map((clause) => clause.id),
  )].map((id) => normalizedId(id, "quality_clause_id")).sort();
  return {
    centralSuitabilityClauseIds,
    minimumPassRatio: finiteRatio(value?.minimumPassRatio ?? 0.8, "quality_minimum_pass_ratio"),
    maximumUnknownRatio: finiteRatio(value?.maximumUnknownRatio ?? 0.2, "quality_maximum_unknown_ratio"),
    zeroKnownFailures: true,
  };
}

function normalizedDirectiveValues(values: readonly string[], name: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const clean = normalizedText(value, name, 500);
    const key = clean.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function normalizedExecutionDirectives(
  value: PlaylistContractExecutionDirectivesV1 | undefined,
): PlaylistContractExecutionDirectivesV1 | undefined {
  if (!value) return undefined;
  const fixedContainer = value.fixedContainer === null
    ? null
    : {
        kind: value.fixedContainer.kind,
        name: normalizedText(value.fixedContainer.name, "fixed_container_name", 500),
        artistName: value.fixedContainer.artistName === null
          ? null
          : normalizedText(value.fixedContainer.artistName, "fixed_container_artist", 500),
        membershipClauseId: normalizedId(
          value.fixedContainer.membershipClauseId,
          "fixed_container_membership_clause_id",
        ),
      };
  if (fixedContainer && fixedContainer.kind !== "album" && fixedContainer.kind !== "playlist") {
    throw new Error("invalid_fixed_container_kind");
  }
  const similarity = value.similarity === null
    ? null
    : {
        seedArtists: normalizedDirectiveValues(
          value.similarity.seedArtists,
          "similarity_seed_artist",
        ),
        excludedArtists: normalizedDirectiveValues(
          value.similarity.excludedArtists,
          "similarity_excluded_artist",
        ),
        rankingClauseId: normalizedId(
          value.similarity.rankingClauseId,
          "similarity_ranking_clause_id",
        ),
        exactArtistExclusionClauseIds: [...new Set(
          value.similarity.exactArtistExclusionClauseIds.map((id) => (
            normalizedId(id, "similarity_exclusion_clause_id")
          )),
        )].sort(),
      };
  if (similarity && similarity.seedArtists.length === 0) {
    throw new Error("similarity_directive_requires_seed");
  }
  if (similarity && (
    similarity.excludedArtists.length === 0
      ? similarity.exactArtistExclusionClauseIds.length !== 0
      : similarity.exactArtistExclusionClauseIds.length === 0
  )) {
    throw new Error("similarity_exclusion_directive_mismatch");
  }
  const exactArtistIdentityExclusions = value.exactArtistIdentityExclusions == null
    ? null
    : {
        bindings: value.exactArtistIdentityExclusions.bindings.map((binding) => ({
          clauseId: normalizedId(
            binding.clauseId,
            "exact_artist_identity_clause_id",
          ),
          catalogArtistId: normalizedText(
            binding.catalogArtistId,
            "exact_artist_identity_catalog_id",
            32,
          ),
          displayName: normalizedText(
            binding.displayName,
            "exact_artist_identity_name",
            500,
          ),
          storefront: normalizedText(
            binding.storefront,
            "exact_artist_identity_storefront",
            20,
          ).toLocaleLowerCase("en-US"),
        })).sort((left, right) => (
          left.clauseId.localeCompare(right.clauseId)
            || left.catalogArtistId.localeCompare(right.catalogArtistId)
        )),
      };
  if (exactArtistIdentityExclusions
    && exactArtistIdentityExclusions.bindings.length === 0) {
    throw new Error("empty_exact_artist_identity_exclusions");
  }
  if (exactArtistIdentityExclusions
    && new Set(exactArtistIdentityExclusions.bindings.map(({ clauseId }) => clauseId))
      .size !== exactArtistIdentityExclusions.bindings.length) {
    throw new Error("duplicate_exact_artist_identity_exclusion_clause");
  }
  if (exactArtistIdentityExclusions
    && exactArtistIdentityExclusions.bindings.some(({ catalogArtistId }) => (
      !/^\d{1,32}$/u.test(catalogArtistId)
    ))) {
    throw new Error("invalid_exact_artist_identity_catalog_id");
  }
  if (!fixedContainer && !similarity && !exactArtistIdentityExclusions) {
    throw new Error("empty_execution_directives");
  }
  return {
    fixedContainer,
    similarity,
    ...(value.exactArtistIdentityExclusions !== undefined
      ? { exactArtistIdentityExclusions }
      : {}),
  };
}

function sameDirectiveValues(left: readonly string[], right: readonly string[]): boolean {
  return stableStringify(normalizedDirectiveValues(left, "directive_comparison"))
    === stableStringify(normalizedDirectiveValues(right, "directive_comparison"));
}

function validateContractStructure(input: {
  requestedTrackCount: number;
  storefront: string;
  clauses: readonly PlaylistContractClauseV1[];
  trackPredicate: PlaylistPredicateV1;
  playlistConstraints: readonly PlaylistQuotaConstraintV1[];
  sequencingObjectives: readonly PlaylistSequencingObjectiveV1[];
  qualityPolicy: PlaylistContractQualityPolicyV1;
  executionDirectives?: PlaylistContractExecutionDirectivesV1;
}): void {
  const byId = new Map(input.clauses.map((clause) => [clause.id, clause]));
  if (byId.size !== input.clauses.length) throw new Error("duplicate_playlist_contract_clause");
  for (const clause of input.clauses) {
    const evidence = clause.evidence;
    if (typeof evidence.required !== "boolean"
      || !Array.isArray(evidence.permittedGrades)
      || (evidence.required && evidence.permittedGrades.length === 0)
      || evidence.permittedGrades.some((grade) => !isPlaylistEvidenceGradeV1(grade))
      || (evidence.minimumGrade !== null
        && !isPlaylistEvidenceGradeV1(evidence.minimumGrade))
      || (evidence.minimumGrade !== null
        && !evidence.permittedGrades.includes(evidence.minimumGrade))) {
      throw new Error("invalid_playlist_contract_evidence_obligation");
    }
    const hardSelection = clause.hardness === "hard"
      && clause.scope === "track"
      && TRACK_PREDICATE_KINDS.has(clause.kind);
    if (hardSelection && !evidence.required) {
      throw new Error("hard_selection_clause_requires_evidence");
    }
    if (hardSelection && (
      evidence.minimumGrade === "model_derived_lead"
      || evidence.permittedGrades.includes("model_derived_lead")
    )) {
      throw new Error("model_lead_cannot_qualify_hard_clause");
    }
  }
  const minimumDiversityAxes = new Set([
    "minimum-distinct-artists",
    "minimum-distinct-albums",
    "minimum-distinct-eras",
    "minimum-distinct-scenes",
    "minimum-distinct-geographies",
  ]);
  const maximumDiversityAxes = new Set([
    "maximum-tracks-per-artist",
    "maximum-tracks-per-album",
  ]);
  const observedDiversityAxes = new Set<string>();
  for (const clause of input.clauses) {
    const minimum = minimumDiversityAxes.has(clause.axis);
    const maximum = maximumDiversityAxes.has(clause.axis);
    if (!minimum && !maximum) continue;
    if (clause.kind !== "quota_diversity"
      || clause.scope !== "playlist"
      || clause.values.length !== 1
      || (minimum && clause.operator !== "balance")
      || (maximum && clause.operator !== "limit")) {
      throw new Error("invalid_playlist_diversity_clause");
    }
    if (observedDiversityAxes.has(clause.axis)) {
      throw new Error("duplicate_playlist_diversity_axis");
    }
    observedDiversityAxes.add(clause.axis);
    const count = Number(clause.values[0]);
    if (!Number.isSafeInteger(count)
      || (minimum && (count < 0 || count > input.requestedTrackCount))
      || (maximum && count < 1)) {
      throw new Error("contradictory_playlist_diversity_clause");
    }
  }
  if (input.executionDirectives?.fixedContainer) {
    const directive = input.executionDirectives.fixedContainer;
    const clause = byId.get(directive.membershipClauseId);
    if (!clause
      || clause.kind !== "membership"
      || clause.scope !== "track"
      || clause.hardness !== "hard"
      || clause.operator !== "require"
      || clause.axis !== directive.kind
      || !sameDirectiveValues(clause.values, [directive.name])
      || !predicateClauseIds(input.trackPredicate).has(clause.id)) {
      throw new Error("fixed_container_directive_clause_mismatch");
    }
  }
  if (input.executionDirectives?.similarity) {
    const directive = input.executionDirectives.similarity;
    const rankingClause = byId.get(directive.rankingClauseId);
    if (!rankingClause
      || rankingClause.kind !== "ranking_preference"
      || rankingClause.scope !== "track"
      || rankingClause.hardness !== "soft"
      || rankingClause.operator !== "prefer"
      || rankingClause.axis !== "similarity"
      || !sameDirectiveValues(rankingClause.values, directive.seedArtists)) {
      throw new Error("similarity_directive_ranking_clause_mismatch");
    }
    const exclusionValues = directive.exactArtistExclusionClauseIds.flatMap((id) => {
      const clause = byId.get(id);
      if (!clause
        || clause.kind !== "exclusion"
        || clause.scope !== "track"
        || clause.hardness !== "hard"
        || clause.operator !== "exclude"
        || clause.axis !== "artist"
        || !predicateClauseIds(input.trackPredicate).has(id)) {
        throw new Error("similarity_directive_exclusion_clause_mismatch");
      }
      return clause.values;
    });
    if (!sameDirectiveValues(exclusionValues, directive.excludedArtists)) {
      throw new Error("similarity_directive_excluded_artist_mismatch");
    }
  }
  if (input.executionDirectives?.exactArtistIdentityExclusions) {
    const directive = input.executionDirectives.exactArtistIdentityExclusions;
    const exclusionValues = directive.bindings.flatMap((binding) => {
      const clause = byId.get(binding.clauseId);
      if (!clause
        || clause.kind !== "exclusion"
        || clause.scope !== "track"
        || clause.hardness !== "hard"
        || clause.operator !== "exclude"
        || clause.axis !== "artist"
        || !predicateClauseIds(input.trackPredicate).has(binding.clauseId)
        || binding.storefront !== input.storefront) {
        throw new Error("exact_artist_identity_exclusion_clause_mismatch");
      }
      return clause.values;
    });
    if (!sameDirectiveValues(
      exclusionValues,
      directive.bindings.map(({ displayName }) => displayName),
    )) {
      throw new Error("exact_artist_identity_excluded_artist_mismatch");
    }
  }
  const trackIds = predicateClauseIds(input.trackPredicate);
  for (const id of trackIds) {
    const clause = byId.get(id);
    if (!clause) throw new Error("unknown_track_predicate_clause");
    if (clause.scope !== "track" || !TRACK_PREDICATE_KINDS.has(clause.kind)) {
      throw new Error("non_track_clause_in_track_predicate");
    }
    if (clause.hardness !== "hard") throw new Error("soft_clause_cannot_gate_track_eligibility");
    if (clause.operator !== "require" && clause.operator !== "exclude") {
      throw new Error("unsupported_hard_track_clause_operator");
    }
    if (clause.kind === "exclusion" && clause.operator !== "exclude") {
      throw new Error("exclusion_clause_requires_exclude_operator");
    }
  }
  for (const quota of input.playlistConstraints) {
    const quotaClause = byId.get(quota.clauseId);
    if (!quotaClause || quotaClause.kind !== "quota_diversity" || quotaClause.scope !== "playlist") {
      throw new Error("invalid_quota_clause");
    }
    for (const id of predicateClauseIds(quota.predicate)) {
      const clause = byId.get(id);
      if (!clause
        || clause.scope !== "track"
        || clause.hardness !== "hard"
        || !TRACK_PREDICATE_KINDS.has(clause.kind)
        || (clause.operator !== "require" && clause.operator !== "exclude")
        || (clause.kind === "exclusion" && clause.operator !== "exclude")) {
        throw new Error("invalid_quota_predicate_clause");
      }
    }
    const effectiveMinimum = Math.max(
      quota.minimumCount ?? 0,
      quota.minimumRatio === null
        ? 0
        : Math.ceil(input.requestedTrackCount * quota.minimumRatio),
    );
    const effectiveMaximum = Math.min(
      input.requestedTrackCount,
      quota.maximumCount ?? input.requestedTrackCount,
      quota.maximumRatio === null
        ? input.requestedTrackCount
        : Math.floor(input.requestedTrackCount * quota.maximumRatio),
    );
    if (effectiveMinimum > effectiveMaximum) {
      throw new Error("contradictory_quota_for_requested_count");
    }
  }
  for (const objective of input.sequencingObjectives) {
    const clause = byId.get(objective.clauseId);
    if (!clause || clause.scope !== "playlist" || clause.kind !== "ranking_preference") {
      throw new Error("invalid_sequencing_clause");
    }
  }
  for (const id of input.qualityPolicy.centralSuitabilityClauseIds) {
    const clause = byId.get(id);
    if (!clause
      || clause.kind !== "suitability"
      || clause.scope !== "track"
      || clause.hardness !== "soft"
      || clause.operator !== "prefer") {
      throw new Error("invalid_central_suitability_clause");
    }
  }
  const referenced = new Set(trackIds);
  input.playlistConstraints.forEach((quota) => (
    predicateClauseIds(quota.predicate).forEach((id) => referenced.add(id))
  ));
  for (const clause of input.clauses) {
    if (clause.hardness === "hard" && clause.scope === "track"
      && TRACK_PREDICATE_KINDS.has(clause.kind) && !referenced.has(clause.id)) {
      throw new Error("orphan_hard_track_clause");
    }
  }
}

interface FinalizeContractInput {
  readonly contractId: string;
  readonly revision: number;
  readonly parentRevisionId: string | null;
  readonly parentSemanticHash: string | null;
  readonly versions: PlaylistContractVersionSnapshotV1;
  readonly rawPrompt: string;
  readonly requestedTrackCount: number;
  readonly locale: string;
  readonly storefront: string;
  readonly clauses: readonly PlaylistContractClauseV1[];
  readonly trackPredicate: PlaylistPredicateV1;
  readonly playlistConstraints: readonly PlaylistQuotaConstraintV1[];
  readonly sequencingObjectives: readonly PlaylistSequencingObjectiveV1[];
  readonly qualityPolicy: PlaylistContractQualityPolicyV1;
  readonly executionDirectives?: PlaylistContractExecutionDirectivesV1;
  readonly answerLineage: readonly PlaylistContractAnswerLineageV1[];
}

function semanticProjection(input: Omit<
  FinalizeContractInput,
  "revision" | "parentRevisionId" | "parentSemanticHash" | "answerLineage"
>): unknown {
  return {
    schemaVersion: PLAYLIST_CONTRACT_SCHEMA_VERSION,
    versions: input.versions,
    rawPrompt: input.rawPrompt,
    requestedTrackCount: input.requestedTrackCount,
    locale: input.locale,
    storefront: input.storefront,
    partialPolicy: "ask",
    clauses: [...input.clauses].sort((left, right) => left.id.localeCompare(right.id)),
    trackPredicate: canonicalPredicate(input.trackPredicate),
    playlistConstraints: [...input.playlistConstraints].map((quota) => ({
      ...quota,
      predicate: canonicalPredicate(quota.predicate),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    sequencingObjectives: [...input.sequencingObjectives]
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
    qualityPolicy: input.qualityPolicy,
    ...(input.executionDirectives ? {
      executionDirectives: input.executionDirectives,
    } : {}),
  };
}

function revisionProjection(
  input: FinalizeContractInput,
  semanticHash: string,
): unknown {
  return {
    schemaVersion: PLAYLIST_CONTRACT_SCHEMA_VERSION,
    contractId: input.contractId,
    revision: input.revision,
    parentRevisionId: input.parentRevisionId,
    parentSemanticHash: input.parentSemanticHash,
    semanticHash,
    answerLineage: input.answerLineage,
  };
}

function finalizeContract(input: FinalizeContractInput): PlaylistContractRevisionV1 {
  validateContractStructure(input);
  const semanticHash = sha256Hex(stableStringify(semanticProjection(input)));
  const revisionId = `pcr1:${sha256Hex(stableStringify(revisionProjection(input, semanticHash)))}`;
  return deepFreeze({
    schemaVersion: PLAYLIST_CONTRACT_SCHEMA_VERSION,
    contractId: input.contractId,
    revisionId,
    revision: input.revision,
    parentRevisionId: input.parentRevisionId,
    parentSemanticHash: input.parentSemanticHash,
    semanticHash,
    versions: copyPlain(input.versions),
    rawPrompt: input.rawPrompt,
    requestedTrackCount: input.requestedTrackCount,
    locale: input.locale,
    storefront: input.storefront,
    partialPolicy: "ask",
    clauses: copyPlain(input.clauses),
    trackPredicate: copyPlain(input.trackPredicate),
    playlistConstraints: copyPlain(input.playlistConstraints),
    sequencingObjectives: copyPlain(input.sequencingObjectives),
    qualityPolicy: copyPlain(input.qualityPolicy),
    ...(input.executionDirectives ? {
      executionDirectives: copyPlain(input.executionDirectives),
    } : {}),
    answerLineage: copyPlain(input.answerLineage),
  });
}

function versionSnapshot(
  versions: Partial<PlaylistContractVersionSnapshotV1> | undefined,
): PlaylistContractVersionSnapshotV1 {
  return {
    compiler: normalizedText(versions?.compiler ?? DEFAULT_VERSIONS.compiler, "compiler_version", 120),
    ontology: normalizedText(versions?.ontology ?? DEFAULT_VERSIONS.ontology, "ontology_version", 120),
    evidencePolicy: normalizedText(
      versions?.evidencePolicy ?? DEFAULT_VERSIONS.evidencePolicy,
      "evidence_policy_version",
      120,
    ),
    questionTemplates: normalizedText(
      versions?.questionTemplates ?? DEFAULT_VERSIONS.questionTemplates,
      "question_template_version",
      120,
    ),
    catalogPolicy: normalizedText(
      versions?.catalogPolicy ?? DEFAULT_VERSIONS.catalogPolicy,
      "catalog_policy_version",
      120,
    ),
  };
}

export function compilePlaylistContractRevisionV1(
  draft: PlaylistContractDraftV1,
): PlaylistContractRevisionV1 {
  const rawPrompt = originalPrompt(draft.rawPrompt);
  const clauses = draft.clauses.map((clause) => compileClause(clause, rawPrompt));
  const trackPredicate = normalizePredicate(draft.trackPredicate);
  const playlistConstraints = (draft.playlistConstraints ?? []).map(normalizeQuotaConstraint);
  const sequencingObjectives = (draft.sequencingObjectives ?? []).map(normalizeSequencingObjective);
  const qualityPolicy = normalizeQualityPolicy(draft.qualityPolicy, clauses);
  const executionDirectives = normalizedExecutionDirectives(draft.executionDirectives);
  return finalizeContract({
    contractId: normalizedId(draft.contractId, "contract_id"),
    revision: 1,
    parentRevisionId: null,
    parentSemanticHash: null,
    versions: versionSnapshot(draft.versions),
    rawPrompt,
    requestedTrackCount: positiveCount(draft.requestedTrackCount, "requested_track_count"),
    locale: normalizedText(draft.locale, "locale", 40).toLocaleLowerCase("en-US"),
    storefront: normalizedText(draft.storefront, "storefront", 20).toLocaleLowerCase("en-US"),
    clauses,
    trackPredicate,
    playlistConstraints,
    sequencingObjectives,
    qualityPolicy,
    ...(executionDirectives ? { executionDirectives } : {}),
    answerLineage: [],
  });
}

function normalizedLineage(value: PlaylistContractAnswerLineageV1): PlaylistContractAnswerLineageV1 {
  const hashPattern = /^[0-9a-f]{64}$/u;
  if (!hashPattern.test(value.questionSetHash) || !hashPattern.test(value.answerHash)) {
    throw new Error("invalid_contract_answer_hash");
  }
  return {
    questionSetHash: value.questionSetHash,
    questionId: normalizedId(value.questionId, "question_id"),
    answerHash: value.answerHash,
  };
}

export function assertPlaylistContractIntegrityV1(contract: PlaylistContractRevisionV1): void {
  if (contract.schemaVersion !== PLAYLIST_CONTRACT_SCHEMA_VERSION) {
    throw new Error("unsupported_playlist_contract_schema");
  }
  validateContractStructure(contract);
  const semanticHash = sha256Hex(stableStringify(semanticProjection(contract)));
  if (semanticHash !== contract.semanticHash) throw new Error("playlist_contract_semantic_hash_mismatch");
  const revisionId = `pcr1:${sha256Hex(stableStringify(revisionProjection(contract, semanticHash)))}`;
  if (revisionId !== contract.revisionId) throw new Error("playlist_contract_revision_hash_mismatch");
}

export function applyPlaylistContractPatchV1(
  base: PlaylistContractRevisionV1,
  patch: PlaylistContractPatchV1,
): PlaylistContractRevisionV1 {
  assertPlaylistContractIntegrityV1(base);
  if (patch.baseRevisionId !== base.revisionId || patch.baseSemanticHash !== base.semanticHash) {
    throw new Error("stale_playlist_contract_revision");
  }
  if (patch.operations.length === 0) throw new Error("empty_playlist_contract_patch");
  let clauses = copyPlain([...base.clauses]);
  let trackPredicate = copyPlain(base.trackPredicate);
  let requestedTrackCount = base.requestedTrackCount;
  let playlistConstraints = copyPlain([...base.playlistConstraints]);
  let sequencingObjectives = copyPlain([...base.sequencingObjectives]);
  let qualityPolicy = copyPlain(base.qualityPolicy);
  let executionDirectives = base.executionDirectives
    ? copyPlain(base.executionDirectives)
    : undefined;

  for (const operation of patch.operations) {
    if (operation.op === "add_clause") {
      const clause = compileClause(operation.clause, base.rawPrompt);
      if (clauses.some((existing) => existing.id === clause.id)) throw new Error("duplicate_playlist_contract_clause");
      clauses.push(clause);
    } else if (operation.op === "replace_clause") {
      const index = clauses.findIndex((clause) => clause.id === operation.clauseId);
      if (index < 0) throw new Error("unknown_playlist_contract_clause");
      clauses[index] = compileClause(operation.clause, base.rawPrompt);
    } else if (operation.op === "remove_clause") {
      const originalLength = clauses.length;
      clauses = clauses.filter((clause) => clause.id !== operation.clauseId);
      if (clauses.length === originalLength) throw new Error("unknown_playlist_contract_clause");
    } else if (operation.op === "replace_track_predicate") {
      trackPredicate = normalizePredicate(operation.predicate);
    } else if (operation.op === "set_requested_track_count") {
      requestedTrackCount = positiveCount(operation.count, "requested_track_count");
    } else if (operation.op === "set_playlist_constraints") {
      playlistConstraints = operation.constraints.map(normalizeQuotaConstraint);
    } else if (operation.op === "set_sequencing_objectives") {
      sequencingObjectives = operation.objectives.map(normalizeSequencingObjective);
    } else if (operation.op === "set_quality_policy") {
      qualityPolicy = normalizeQualityPolicy(operation.policy, clauses);
    } else if (operation.op === "set_exact_artist_identity_exclusions") {
      const existing = executionDirectives ?? {
        fixedContainer: null,
        similarity: null,
      };
      executionDirectives = operation.directive === null
        && !existing.fixedContainer && !existing.similarity
        ? undefined
        : normalizedExecutionDirectives({
            ...existing,
            exactArtistIdentityExclusions: operation.directive,
          });
    }
  }

  const next = finalizeContract({
    contractId: base.contractId,
    revision: base.revision + 1,
    parentRevisionId: base.revisionId,
    parentSemanticHash: base.semanticHash,
    versions: base.versions,
    rawPrompt: base.rawPrompt,
    requestedTrackCount,
    locale: base.locale,
    storefront: base.storefront,
    clauses,
    trackPredicate,
    playlistConstraints,
    sequencingObjectives,
    qualityPolicy,
    ...(executionDirectives ? {
      executionDirectives,
    } : {}),
    answerLineage: [...base.answerLineage, normalizedLineage(patch.answerLineage)],
  });
  if (next.semanticHash === base.semanticHash) throw new Error("contract_patch_did_not_change_semantics");
  return next;
}

/**
 * Replace an earlier guidance answer without replaying its patch against the
 * current contract. The replacement is compiled against the immutable
 * historical base, while the resulting revision is fenced as a child of the
 * active revision. This intentionally drops the replaced answer and every
 * dependent later answer from the executable lineage.
 */
export function rebasePlaylistContractPatchV1(input: {
  active: PlaylistContractRevisionV1;
  historicalBase: PlaylistContractRevisionV1;
  replacementPatch: PlaylistContractPatchV1;
}): PlaylistContractRevisionV1 {
  assertPlaylistContractIntegrityV1(input.active);
  assertPlaylistContractIntegrityV1(input.historicalBase);
  if (input.active.contractId !== input.historicalBase.contractId
    || input.active.rawPrompt !== input.historicalBase.rawPrompt
    || input.active.locale !== input.historicalBase.locale
    || input.active.storefront !== input.historicalBase.storefront
    || stableStringify(input.active.versions)
      !== stableStringify(input.historicalBase.versions)) {
    throw new Error("historical_playlist_contract_not_in_active_lineage");
  }
  const historicalLineage = input.historicalBase.answerLineage;
  if (historicalLineage.length > input.active.answerLineage.length
    || historicalLineage.some((entry, index) => (
      stableStringify(entry)
        !== stableStringify(input.active.answerLineage[index])
    ))) {
    throw new Error("historical_playlist_contract_not_in_active_lineage");
  }
  if (input.replacementPatch.baseRevisionId
      !== input.historicalBase.revisionId
    || input.replacementPatch.baseSemanticHash
      !== input.historicalBase.semanticHash) {
    throw new Error("stale_playlist_contract_revision");
  }
  const revised = input.replacementPatch.operations.length > 0
    ? applyPlaylistContractPatchV1(
        input.historicalBase,
        input.replacementPatch,
      )
    : {
        ...input.historicalBase,
        answerLineage: [
          ...input.historicalBase.answerLineage,
          normalizedLineage(input.replacementPatch.answerLineage),
        ],
      };
  const next = finalizeContract({
    contractId: input.active.contractId,
    revision: input.active.revision + 1,
    parentRevisionId: input.active.revisionId,
    parentSemanticHash: input.active.semanticHash,
    versions: revised.versions,
    rawPrompt: revised.rawPrompt,
    requestedTrackCount: revised.requestedTrackCount,
    locale: revised.locale,
    storefront: revised.storefront,
    clauses: revised.clauses,
    trackPredicate: revised.trackPredicate,
    playlistConstraints: revised.playlistConstraints,
    sequencingObjectives: revised.sequencingObjectives,
    qualityPolicy: revised.qualityPolicy,
    ...(revised.executionDirectives ? {
      executionDirectives: revised.executionDirectives,
    } : {}),
    answerLineage: revised.answerLineage,
  });
  if (next.semanticHash === input.active.semanticHash
    && stableStringify(next.answerLineage)
      === stableStringify(input.active.answerLineage)) {
    throw new Error("guidance_revision_did_not_change_contract");
  }
  return next;
}

function clauseAssessment(
  clause: PlaylistContractClauseV1,
  assessment: PlaylistClauseAssessmentV1 | undefined,
  evidencePolicyVersion: string,
): PlaylistClauseEvaluationV1 {
  const observedStatus = assessment?.status;
  const rawStatus: PlaylistContractTriStateV1 = observedStatus === "pass"
    || observedStatus === "fail"
    || observedStatus === "unknown"
    ? observedStatus
    : "unknown";
  const evidenceGrade = assessment?.evidenceGrade ?? null;
  let supportedStatus = rawStatus;
  let insufficientEvidence = false;
  if (rawStatus !== "unknown" && clause.evidence.required
    && !playlistEvidenceGradeSatisfiesObligationV1({
      grade: evidenceGrade,
      obligation: clause.evidence,
      evidencePolicyVersion,
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })) {
    supportedStatus = "unknown";
    insufficientEvidence = true;
  }
  if (clause.kind === "exclusion") {
    if (supportedStatus === "pass") {
      return {
        clauseId: clause.id,
        status: "fail",
        rawStatus,
        reason: "excluded_match",
        evidenceGrade,
      };
    }
    if (supportedStatus === "fail") {
      return {
        clauseId: clause.id,
        status: "pass",
        rawStatus,
        reason: "excluded_absent",
        evidenceGrade,
      };
    }
    return {
      clauseId: clause.id,
      status: clause.unknownPolicy === "reject"
        ? "fail"
        : clause.unknownPolicy === "allow"
          ? "pass"
          : "unknown",
      rawStatus,
      reason: insufficientEvidence ? "insufficient_evidence_grade" : "exclusion_unknown",
      evidenceGrade,
    };
  }
  return {
    clauseId: clause.id,
    status: supportedStatus,
    rawStatus,
    reason: insufficientEvidence
      ? "insufficient_evidence_grade"
      : supportedStatus === "pass"
        ? "supported"
        : supportedStatus === "fail"
          ? "refuted"
          : "unknown",
    evidenceGrade,
  };
}

function invertTriState(value: PlaylistContractTriStateV1): PlaylistContractTriStateV1 {
  return value === "pass" ? "fail" : value === "fail" ? "pass" : "unknown";
}

function allTriState(values: readonly PlaylistContractTriStateV1[]): PlaylistContractTriStateV1 {
  if (values.includes("fail")) return "fail";
  if (values.includes("unknown")) return "unknown";
  return "pass";
}

function anyTriState(values: readonly PlaylistContractTriStateV1[]): PlaylistContractTriStateV1 {
  if (values.includes("pass")) return "pass";
  if (values.includes("unknown")) return "unknown";
  return "fail";
}

function evaluatePredicate(
  predicate: PlaylistPredicateV1,
  evaluateClause: (clauseId: string) => PlaylistContractTriStateV1,
): PlaylistContractTriStateV1 {
  if (predicate.op === "clause") return evaluateClause(predicate.clauseId);
  if (predicate.op === "not") return invertTriState(evaluatePredicate(predicate.child, evaluateClause));
  if (predicate.op === "except") {
    const base = evaluatePredicate(predicate.base, evaluateClause);
    const exceptions = anyTriState(predicate.exceptions.map((value) => evaluatePredicate(value, evaluateClause)));
    return allTriState([base, invertTriState(exceptions)]);
  }
  if (predicate.op === "alternative") {
    return anyTriState(predicate.choices.map((choice) => evaluatePredicate(choice.predicate, evaluateClause)));
  }
  const children = predicate.children.map((value) => evaluatePredicate(value, evaluateClause));
  return predicate.op === "all" ? allTriState(children) : anyTriState(children);
}

function predicateEvaluation(
  contract: PlaylistContractRevisionV1,
  predicate: PlaylistPredicateV1,
  assessments: Readonly<Record<string, PlaylistClauseAssessmentV1>>,
): PlaylistPredicateEvaluationV1 {
  const byId = new Map(contract.clauses.map((clause) => [clause.id, clause]));
  const clauses: Record<string, PlaylistClauseEvaluationV1> = {};
  const status = evaluatePredicate(predicate, (clauseId) => {
    const clause = byId.get(clauseId);
    if (!clause) throw new Error("unknown_playlist_contract_clause");
    const evaluated = clauses[clauseId] ?? clauseAssessment(
      clause,
      assessments[clauseId],
      contract.versions.evidencePolicy,
    );
    clauses[clauseId] = evaluated;
    return evaluated.status;
  });
  return { status, eligible: status === "pass", clauses };
}

export function evaluatePlaylistContractTrackV1(
  contract: PlaylistContractRevisionV1,
  assessments: Readonly<Record<string, PlaylistClauseAssessmentV1>>,
): PlaylistPredicateEvaluationV1 {
  assertPlaylistContractIntegrityV1(contract);
  return predicateEvaluation(contract, contract.trackPredicate, assessments);
}

export function evaluatePlaylistQuotasV1(
  contract: PlaylistContractRevisionV1,
  trackAssessments: readonly Readonly<Record<string, PlaylistClauseAssessmentV1>>[],
): readonly PlaylistQuotaEvaluationV1[] {
  assertPlaylistContractIntegrityV1(contract);
  const totalCount = trackAssessments.length;
  return contract.playlistConstraints.map((constraint) => {
    const statuses = trackAssessments.map((assessments) => (
      predicateEvaluation(contract, constraint.predicate, assessments).status
    ));
    const passCount = statuses.filter((status) => status === "pass").length;
    const unknownCount = statuses.filter((status) => status === "unknown").length;
    const lowerRatio = totalCount === 0 ? 0 : passCount / totalCount;
    const upperRatio = totalCount === 0 ? 0 : (passCount + unknownCount) / totalCount;
    const checks: PlaylistContractTriStateV1[] = [];
    if (constraint.minimumCount !== null) {
      checks.push(passCount >= constraint.minimumCount
        ? "pass"
        : passCount + unknownCount < constraint.minimumCount
          ? "fail"
          : "unknown");
    }
    if (constraint.maximumCount !== null) {
      checks.push(passCount > constraint.maximumCount
        ? "fail"
        : passCount + unknownCount <= constraint.maximumCount
          ? "pass"
          : "unknown");
    }
    if (constraint.minimumRatio !== null) {
      checks.push(lowerRatio >= constraint.minimumRatio
        ? "pass"
        : upperRatio < constraint.minimumRatio
          ? "fail"
          : "unknown");
    }
    if (constraint.maximumRatio !== null) {
      checks.push(lowerRatio > constraint.maximumRatio
        ? "fail"
        : upperRatio <= constraint.maximumRatio
          ? "pass"
          : "unknown");
    }
    return {
      id: constraint.id,
      status: allTriState(checks),
      passCount,
      unknownCount,
      totalCount,
    };
  });
}

export function evaluatePlaylistQualityV1(
  contract: PlaylistContractRevisionV1,
  trackAssessments: readonly Readonly<Record<string, PlaylistClauseAssessmentV1>>[],
): PlaylistQualityEvaluationV1 {
  assertPlaylistContractIntegrityV1(contract);
  const byId = new Map(contract.clauses.map((clause) => [clause.id, clause]));
  const statuses: PlaylistContractTriStateV1[] = [];
  for (const assessments of trackAssessments) {
    for (const clauseId of contract.qualityPolicy.centralSuitabilityClauseIds) {
      const clause = byId.get(clauseId);
      if (!clause) throw new Error("unknown_central_suitability_clause");
      statuses.push(clauseAssessment(
        clause,
        assessments[clauseId],
        contract.versions.evidencePolicy,
      ).status);
    }
  }
  const totalAssessments = statuses.length;
  const passCount = statuses.filter((status) => status === "pass").length;
  const failCount = statuses.filter((status) => status === "fail").length;
  const unknownCount = statuses.filter((status) => status === "unknown").length;
  const passRatio = totalAssessments === 0 ? 1 : passCount / totalAssessments;
  const unknownRatio = totalAssessments === 0 ? 0 : unknownCount / totalAssessments;
  const status: PlaylistContractTriStateV1 = failCount > 0
    ? "fail"
    : passRatio >= contract.qualityPolicy.minimumPassRatio
      && unknownRatio <= contract.qualityPolicy.maximumUnknownRatio
      ? "pass"
      : "unknown";
  return {
    status,
    passRatio,
    unknownRatio,
    failCount,
    passCount,
    unknownCount,
    totalAssessments,
  };
}
