import type {
  CanonicalPlaylistContractClauseAssessmentV1,
  CanonicalPlaylistContractClauseV1,
  CanonicalPlaylistContractEvidenceGradeV1,
  CanonicalPlaylistContractExecutionPolicyV1,
  CanonicalPlaylistContractPredicateV1,
  CanonicalPlaylistContractTriStateV1,
} from "../shared/types.ts";
import {
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import {
  PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
  isPlaylistEvidenceGradeV1,
  isSupportedPlaylistEvidencePolicyVersionV1,
  playlistEvidenceGradeSatisfiesObligationV1,
} from "./playlist-evidence-policy-v1.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const CANONICAL_CONTRACT_RUNTIME_POLICY_VERSION =
  "canonical_contract_runtime_v1" as const;

function copyPredicate(
  predicate: PlaylistContractRevisionV1["trackPredicate"],
): CanonicalPlaylistContractPredicateV1 {
  if (predicate.op === "clause") return { op: "clause", clauseId: predicate.clauseId };
  if (predicate.op === "not") {
    return { op: "not", child: copyPredicate(predicate.child) };
  }
  if (predicate.op === "except") {
    return {
      op: "except",
      base: copyPredicate(predicate.base),
      exceptions: predicate.exceptions.map(copyPredicate),
    };
  }
  if (predicate.op === "alternative") {
    return {
      op: "alternative",
      choices: predicate.choices.map((choice) => ({
        id: choice.id,
        priority: choice.priority,
        predicate: copyPredicate(choice.predicate),
      })),
    };
  }
  return {
    op: predicate.op,
    children: predicate.children.map(copyPredicate),
  };
}

function predicateClauseIds(
  predicate: CanonicalPlaylistContractPredicateV1,
  ids = new Set<string>(),
): Set<string> {
  if (predicate.op === "clause") ids.add(predicate.clauseId);
  else if (predicate.op === "not") predicateClauseIds(predicate.child, ids);
  else if (predicate.op === "except") {
    predicateClauseIds(predicate.base, ids);
    predicate.exceptions.forEach((value) => predicateClauseIds(value, ids));
  } else if (predicate.op === "alternative") {
    predicate.choices.forEach(({ predicate: value }) => predicateClauseIds(value, ids));
  } else {
    predicate.children.forEach((value) => predicateClauseIds(value, ids));
  }
  return ids;
}

function runtimeProjection(
  policy: Omit<CanonicalPlaylistContractExecutionPolicyV1, "projectionHash">,
): unknown {
  return {
    policyVersion: policy.policyVersion,
    evidenceStrengthPolicyVersion: policy.evidenceStrengthPolicyVersion,
    contractRevisionId: policy.contractRevisionId,
    contractSemanticHash: policy.contractSemanticHash,
    contractCompilerVersion: policy.contractCompilerVersion,
    evidencePolicyVersion: policy.evidencePolicyVersion,
    catalogPolicyVersion: policy.catalogPolicyVersion,
    requestedTrackCount: policy.requestedTrackCount,
    storefront: policy.storefront,
    clauses: [...policy.clauses].sort((left, right) => left.id.localeCompare(right.id)),
    trackPredicate: policy.trackPredicate,
    ...(policy.executionDirectives ? {
      executionDirectives: policy.executionDirectives,
    } : {}),
  };
}

export function canonicalContractExecutionPolicyV1(
  contract: PlaylistContractRevisionV1,
): CanonicalPlaylistContractExecutionPolicyV1 {
  assertPlaylistContractIntegrityV1(contract);
  if (!isSupportedPlaylistEvidencePolicyVersionV1(contract.versions.evidencePolicy)) {
    throw new Error("unsupported_canonical_contract_evidence_policy");
  }
  const trackPredicate = copyPredicate(contract.trackPredicate);
  const referenced = predicateClauseIds(trackPredicate);
  contract.playlistConstraints.forEach(({ predicate }) => (
    predicateClauseIds(copyPredicate(predicate), referenced)
  ));
  const centralSuitabilityClauseIds = new Set(
    contract.qualityPolicy.centralSuitabilityClauseIds,
  );
  centralSuitabilityClauseIds.forEach((id) => referenced.add(id));
  const clauses: CanonicalPlaylistContractClauseV1[] = contract.clauses
    .filter((clause) => referenced.has(clause.id))
    .map((clause) => {
      const centralSuitability = centralSuitabilityClauseIds.has(clause.id);
      const validCentralSuitability = centralSuitability
        && clause.scope === "track"
        && clause.hardness === "soft"
        && clause.kind === "suitability"
        && clause.operator === "prefer";
      const validHardTrackClause = !centralSuitability
        && clause.scope === "track"
        && clause.hardness === "hard"
        && [
          "membership",
          "factual_relationship",
          "suitability",
          "exclusion",
          "catalog_version",
        ].includes(clause.kind)
        && ["require", "exclude"].includes(clause.operator);
      if (!validCentralSuitability && !validHardTrackClause) {
        throw new Error(`unsupported_canonical_runtime_clause:${clause.id}`);
      }
      return {
        id: clause.id,
        kind: clause.kind as CanonicalPlaylistContractClauseV1["kind"],
        axis: clause.axis,
        // Central suitability remains outside `trackPredicate`; projecting its
        // positive preference as a runtime requirement lets evidence coverage
        // and quality-floor evaluation share the exact clause obligation
        // without turning it into hard per-track membership.
        operator: centralSuitability
          ? "require" as const
          : clause.operator as CanonicalPlaylistContractClauseV1["operator"],
        values: [...clause.values, ...clause.concepts.flatMap((concept) => {
          if (concept.status !== "resolved" || !concept.selectedConceptId) return [];
          const selected = concept.candidates.find(
            (candidate) => candidate.conceptId === concept.selectedConceptId,
          );
          return [selected?.label ?? concept.originalText];
        })],
        unknownPolicy: clause.unknownPolicy,
        evidence: {
          required: clause.evidence.required,
          minimumGrade: clause.evidence.minimumGrade,
          permittedGrades: [...clause.evidence.permittedGrades],
        },
      };
    });
  const base = {
    policyVersion: CANONICAL_CONTRACT_RUNTIME_POLICY_VERSION,
    evidenceStrengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    contractRevisionId: contract.revisionId,
    contractSemanticHash: contract.semanticHash,
    contractCompilerVersion: contract.versions.compiler,
    evidencePolicyVersion: contract.versions.evidencePolicy,
    catalogPolicyVersion: contract.versions.catalogPolicy,
    requestedTrackCount: contract.requestedTrackCount,
    storefront: contract.storefront,
    clauses,
    trackPredicate,
    ...(contract.executionDirectives ? {
      executionDirectives: structuredClone(contract.executionDirectives),
    } : {}),
  } satisfies Omit<CanonicalPlaylistContractExecutionPolicyV1, "projectionHash">;
  return Object.freeze({
    ...base,
    projectionHash: sha256Hex(stableStringify(runtimeProjection(base))),
  });
}

export function assertCanonicalContractExecutionPolicyV1(
  policy: CanonicalPlaylistContractExecutionPolicyV1,
): void {
  if (policy.policyVersion !== CANONICAL_CONTRACT_RUNTIME_POLICY_VERSION
    || policy.evidenceStrengthPolicyVersion !== PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION
    || !policy.contractRevisionId.startsWith("pcr1:")
    || !/^[a-f0-9]{64}$/u.test(policy.contractSemanticHash)
    || !/^[a-f0-9]{64}$/u.test(policy.projectionHash)
    || !Number.isSafeInteger(policy.requestedTrackCount)
    || policy.requestedTrackCount < 1
    || !/^[a-z]{2}$/u.test(policy.storefront)) {
    throw new Error("invalid_canonical_contract_runtime_policy");
  }
  if (!isSupportedPlaylistEvidencePolicyVersionV1(policy.evidencePolicyVersion)) {
    throw new Error("unsupported_canonical_contract_evidence_policy");
  }
  const ids = new Set(policy.clauses.map(({ id }) => id));
  if (ids.size !== policy.clauses.length) {
    throw new Error("duplicate_canonical_contract_runtime_clause");
  }
  for (const clause of policy.clauses) {
    if (!clause.evidence.required
      || !Array.isArray(clause.evidence.permittedGrades)
      || clause.evidence.permittedGrades.length === 0
      || clause.evidence.permittedGrades.some((grade) => (
        !isPlaylistEvidenceGradeV1(grade) || grade === "model_derived_lead"
      ))
      || (clause.evidence.minimumGrade !== null
        && (!isPlaylistEvidenceGradeV1(clause.evidence.minimumGrade)
          || clause.evidence.minimumGrade === "model_derived_lead"
          || !clause.evidence.permittedGrades.includes(clause.evidence.minimumGrade)))) {
      throw new Error("invalid_canonical_contract_evidence_obligation");
    }
  }
  for (const id of predicateClauseIds(policy.trackPredicate)) {
    if (!ids.has(id)) throw new Error("unknown_canonical_contract_runtime_clause");
  }
  const directives = policy.executionDirectives;
  if (directives) {
    if (!directives.fixedContainer
      && !directives.fixedTrackList
      && !directives.similarity
      && !directives.exactArtistIdentityExclusions) {
      throw new Error("empty_canonical_contract_execution_directives");
    }
    if (directives.fixedContainer) {
      const fixed = directives.fixedContainer;
      const clause = policy.clauses.find(({ id }) => id === fixed.membershipClauseId);
      if (!["album", "playlist"].includes(fixed.kind)
        || typeof fixed.name !== "string" || !fixed.name.trim()
        || (fixed.artistName !== null
          && (typeof fixed.artistName !== "string" || !fixed.artistName.trim()))
        || !clause
        || clause.kind !== "membership"
        || clause.axis !== fixed.kind
        || clause.operator !== "require"
        || clause.values.length !== 1
        || clause.values[0] !== fixed.name) {
        throw new Error("invalid_canonical_fixed_container_directive");
      }
    }
    if (directives.fixedTrackList) {
      const fixed = directives.fixedTrackList;
      const clause = policy.clauses.find(
        ({ id }) => id === fixed.membershipClauseId,
      );
      const tracks = Array.isArray(fixed.tracks) ? fixed.tracks : [];
      const expected = tracks.map(
        ({ artist, title }) => `${artist} — ${title}`,
      ).sort((left, right) => left.localeCompare(right));
      const observed = [...(clause?.values ?? [])]
        .sort((left, right) => left.localeCompare(right));
      if (!Array.isArray(fixed.tracks)
        || tracks.length !== policy.requestedTrackCount
        || tracks.some(({ artist, title }) => (
          typeof artist !== "string" || !artist.trim()
          || typeof title !== "string" || !title.trim()
        ))
        || new Set(tracks.map(({ artist, title }) => (
          `${artist.toLocaleLowerCase("en-US")}\u0000${title.toLocaleLowerCase("en-US")}`
        ))).size !== tracks.length
        || !clause
        || clause.kind !== "membership"
        || clause.axis !== "track"
        || clause.operator !== "require"
        || JSON.stringify(observed) !== JSON.stringify(expected)) {
        throw new Error("invalid_canonical_fixed_track_list_directive");
      }
    }
    if (directives.similarity) {
      const similarity = directives.similarity;
      if (!Array.isArray(similarity.seedArtists) || similarity.seedArtists.length === 0
        || similarity.seedArtists.some((value) => typeof value !== "string" || !value.trim())
        || !Array.isArray(similarity.excludedArtists)
        || similarity.excludedArtists.some((value) => typeof value !== "string" || !value.trim())
        || typeof similarity.rankingClauseId !== "string" || !similarity.rankingClauseId
        || !Array.isArray(similarity.exactArtistExclusionClauseIds)
        || (similarity.excludedArtists.length === 0
          ? similarity.exactArtistExclusionClauseIds.length !== 0
          : similarity.exactArtistExclusionClauseIds.length === 0)) {
        throw new Error("invalid_canonical_similarity_directive");
      }
      const excluded = similarity.exactArtistExclusionClauseIds.flatMap((id) => {
        const clause = policy.clauses.find((candidate) => candidate.id === id);
        if (!clause
          || clause.kind !== "exclusion"
          || clause.axis !== "artist"
          || clause.operator !== "exclude") {
          throw new Error("invalid_canonical_similarity_exclusion_directive");
        }
        return clause.values;
      }).map((value) => value.toLocaleLowerCase("en-US")).sort();
      const expectedExcluded = similarity.excludedArtists
        .map((value) => value.toLocaleLowerCase("en-US")).sort();
      if (stableStringify(excluded) !== stableStringify(expectedExcluded)) {
        throw new Error("canonical_similarity_exclusion_directive_mismatch");
      }
    }
    if (directives.exactArtistIdentityExclusions) {
      const exact = directives.exactArtistIdentityExclusions;
      if (!Array.isArray(exact.bindings) || exact.bindings.length === 0
        || exact.bindings.some((binding) => (
          !binding || typeof binding !== "object"
          || typeof binding.clauseId !== "string" || !binding.clauseId.trim()
          || typeof binding.catalogArtistId !== "string"
          || !/^\d{1,32}$/u.test(binding.catalogArtistId)
          || typeof binding.displayName !== "string" || !binding.displayName.trim()
          || binding.storefront !== policy.storefront
        ))) {
        throw new Error("invalid_canonical_exact_artist_identity_directive");
      }
      if (new Set(exact.bindings.map(({ clauseId }) => clauseId)).size
        !== exact.bindings.length) {
        throw new Error("duplicate_canonical_exact_artist_identity_directive");
      }
      const excluded = exact.bindings.flatMap((binding) => {
        const clause = policy.clauses.find(
          (candidate) => candidate.id === binding.clauseId,
        );
        if (!clause
          || clause.kind !== "exclusion"
          || clause.axis !== "artist"
          || clause.operator !== "exclude") {
          throw new Error("invalid_canonical_exact_artist_identity_exclusion");
        }
        return clause.values;
      }).map((value) => value.toLocaleLowerCase("en-US")).sort();
      const expectedExcluded = exact.bindings
        .map(({ displayName }) => displayName.toLocaleLowerCase("en-US"))
        .sort();
      if (stableStringify(excluded) !== stableStringify(expectedExcluded)) {
        throw new Error("canonical_exact_artist_identity_directive_mismatch");
      }
    }
  }
  const expected = sha256Hex(stableStringify(runtimeProjection({
    policyVersion: policy.policyVersion,
    evidenceStrengthPolicyVersion: policy.evidenceStrengthPolicyVersion,
    contractRevisionId: policy.contractRevisionId,
    contractSemanticHash: policy.contractSemanticHash,
    contractCompilerVersion: policy.contractCompilerVersion,
    evidencePolicyVersion: policy.evidencePolicyVersion,
    catalogPolicyVersion: policy.catalogPolicyVersion,
    requestedTrackCount: policy.requestedTrackCount,
    storefront: policy.storefront,
    clauses: policy.clauses,
    trackPredicate: policy.trackPredicate,
    ...(policy.executionDirectives ? {
      executionDirectives: policy.executionDirectives,
    } : {}),
  })));
  if (expected !== policy.projectionHash) {
    throw new Error("canonical_contract_runtime_projection_hash_mismatch");
  }
}

function invert(value: CanonicalPlaylistContractTriStateV1): CanonicalPlaylistContractTriStateV1 {
  return value === "pass" ? "fail" : value === "fail" ? "pass" : "unknown";
}

function all(values: readonly CanonicalPlaylistContractTriStateV1[]): CanonicalPlaylistContractTriStateV1 {
  if (values.includes("fail")) return "fail";
  if (values.includes("unknown")) return "unknown";
  return "pass";
}

function any(values: readonly CanonicalPlaylistContractTriStateV1[]): CanonicalPlaylistContractTriStateV1 {
  if (values.includes("pass")) return "pass";
  if (values.includes("unknown")) return "unknown";
  return "fail";
}

function clauseStatus(
  clause: CanonicalPlaylistContractClauseV1,
  assessment: CanonicalPlaylistContractClauseAssessmentV1 | undefined,
  evidencePolicyVersion: string,
  evidenceStrengthPolicyVersion: string,
  applyUnknownPolicy = true,
): CanonicalPlaylistContractTriStateV1 {
  const observed = assessment?.status;
  const raw: CanonicalPlaylistContractTriStateV1 = observed === "pass"
    || observed === "fail"
    || observed === "unknown"
    ? observed
    : "unknown";
  const grade = assessment?.evidenceGrade ?? null;
  const supported = raw !== "unknown"
    && !playlistEvidenceGradeSatisfiesObligationV1({
      grade,
      obligation: clause.evidence,
      evidencePolicyVersion,
      strengthPolicyVersion: evidenceStrengthPolicyVersion,
    })
    ? "unknown"
    : raw;
  if (clause.kind === "exclusion") {
    if (supported === "pass") return "fail";
    if (supported === "fail") return "pass";
  } else if (clause.operator === "exclude") {
    if (supported === "pass") return "fail";
    if (supported === "fail") return "pass";
  }
  if (supported !== "unknown") return supported;
  if (!applyUnknownPolicy) return "unknown";
  return clause.unknownPolicy === "reject"
    ? "fail"
    : clause.unknownPolicy === "allow"
      ? "pass"
      : "unknown";
}

function evaluatePredicate(
  predicate: CanonicalPlaylistContractPredicateV1,
  statusFor: (id: string) => CanonicalPlaylistContractTriStateV1,
): CanonicalPlaylistContractTriStateV1 {
  if (predicate.op === "clause") return statusFor(predicate.clauseId);
  if (predicate.op === "not") return invert(evaluatePredicate(predicate.child, statusFor));
  if (predicate.op === "except") {
    return all([
      evaluatePredicate(predicate.base, statusFor),
      invert(any(predicate.exceptions.map((value) => evaluatePredicate(value, statusFor)))),
    ]);
  }
  if (predicate.op === "alternative") {
    return any(predicate.choices
      .slice()
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map((choice) => evaluatePredicate(choice.predicate, statusFor)));
  }
  const children = predicate.children.map((value) => evaluatePredicate(value, statusFor));
  return predicate.op === "all" ? all(children) : any(children);
}

export interface CanonicalContractTrackEvaluationV1 {
  status: CanonicalPlaylistContractTriStateV1;
  eligible: boolean;
  clauseStatuses: Record<string, CanonicalPlaylistContractTriStateV1>;
}

export function evaluateCanonicalContractTrackV1(input: {
  policy: CanonicalPlaylistContractExecutionPolicyV1;
  assessments: Readonly<Record<string, CanonicalPlaylistContractClauseAssessmentV1>>;
}): CanonicalContractTrackEvaluationV1 {
  assertCanonicalContractExecutionPolicyV1(input.policy);
  const clauses = new Map(input.policy.clauses.map((clause) => [clause.id, clause]));
  const clauseStatuses: Record<string, CanonicalPlaylistContractTriStateV1> = {};
  const status = evaluatePredicate(input.policy.trackPredicate, (id) => {
    const clause = clauses.get(id);
    if (!clause) throw new Error("unknown_canonical_contract_runtime_clause");
    const evaluated = clauseStatuses[id] ?? clauseStatus(
      clause,
      input.assessments[id],
      input.policy.evidencePolicyVersion,
      input.policy.evidenceStrengthPolicyVersion,
    );
    clauseStatuses[id] = evaluated;
    return evaluated;
  });
  return { status, eligible: status === "pass", clauseStatuses };
}

/**
 * Evaluate what the evidence actually established without converting an
 * unknown through the contract's selection policy. Selection may still fail
 * closed on unknown, but persistence and coverage auditing must retain the
 * difference between "not proven" and a factual negative.
 */
export function evaluateCanonicalContractTrackEvidenceStateV1(input: {
  policy: CanonicalPlaylistContractExecutionPolicyV1;
  assessments: Readonly<Record<string, CanonicalPlaylistContractClauseAssessmentV1>>;
}): CanonicalContractTrackEvaluationV1 {
  assertCanonicalContractExecutionPolicyV1(input.policy);
  const clauses = new Map(input.policy.clauses.map((clause) => [clause.id, clause]));
  const clauseStatuses: Record<string, CanonicalPlaylistContractTriStateV1> = {};
  const status = evaluatePredicate(input.policy.trackPredicate, (id) => {
    const clause = clauses.get(id);
    if (!clause) throw new Error("unknown_canonical_contract_runtime_clause");
    const evaluated = clauseStatuses[id] ?? clauseStatus(
      clause,
      input.assessments[id],
      input.policy.evidencePolicyVersion,
      input.policy.evidenceStrengthPolicyVersion,
      false,
    );
    clauseStatuses[id] = evaluated;
    return evaluated;
  });
  return { status, eligible: status === "pass", clauseStatuses };
}

export function evaluateCanonicalContractPredicateV1(input: {
  policy: CanonicalPlaylistContractExecutionPolicyV1;
  predicate: CanonicalPlaylistContractPredicateV1;
  assessments: Readonly<Record<string, CanonicalPlaylistContractClauseAssessmentV1>>;
}): CanonicalPlaylistContractTriStateV1 {
  assertCanonicalContractExecutionPolicyV1(input.policy);
  const clauses = new Map(input.policy.clauses.map((clause) => [clause.id, clause]));
  return evaluatePredicate(input.predicate, (id) => {
    const clause = clauses.get(id);
    if (!clause) throw new Error("unknown_canonical_contract_runtime_clause");
    return clauseStatus(
      clause,
      input.assessments[id],
      input.policy.evidencePolicyVersion,
      input.policy.evidenceStrengthPolicyVersion,
    );
  });
}

export function canonicalEvidenceGradeForBindingV1(input: {
  kind: string;
  accessMethod: string;
}): CanonicalPlaylistContractEvidenceGradeV1 {
  const kind = input.kind.toLocaleLowerCase("en-US");
  // Transport is not entailment. In particular, reading an editorial
  // playlist through Apple's public API does not turn that playlist's
  // association into direct track metadata. Classify the governed binding
  // kind first so a container can satisfy only obligations that explicitly
  // permit trusted-container association.
  if (kind === "apple_editorial_container"
    || kind === "fixed_container"
    || kind === "trusted_scoped_container") return "trusted_scoped_container";
  if (kind === "primary_source") return "primary_source";
  if (kind === "hosted_web_track"
    || kind === "track_specific_editorial_assertion") {
    return "track_specific_editorial_assertion";
  }
  if (kind === "artist_catalogue"
    || kind === "authoritative_structured_metadata") {
    return "authoritative_structured_metadata";
  }
  if (kind === "governed_graph"
    || kind === "independent_secondary_source") return "independent_secondary_source";
  // Unknown future bindings fail selection-grade obligations until their
  // entailment is explicitly classified, even when delivered by a public API.
  return "model_derived_lead";
}
