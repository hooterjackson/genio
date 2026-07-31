import {
  PLAYLIST_CONTRACT_CATALOG_POLICY_VERSION,
  PLAYLIST_CONTRACT_COMPILER_VERSION,
  PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION,
  PLAYLIST_CONTRACT_QUESTION_TEMPLATE_VERSION,
  PLAYLIST_CONTRACT_SCHEMA_VERSION,
  assertPlaylistContractIntegrityV1,
  type PlaylistContractEvidenceGradeV1,
  type PlaylistContractRevisionV1,
  type PlaylistPredicateV1,
} from "./playlist-contract-v1.ts";
import {
  PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION,
  PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION,
} from "./playlist-contract-shadow-bridge-v1.ts";
import {
  LEGACY_PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
} from "./music-concept-registry-v1.ts";
import {
  PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
} from "./playlist-evidence-policy-v1.ts";
import {
  backendSupportsContract,
  type BackendCapabilityDeclaration,
  type BackendCapabilityResult,
  type ContractCapabilityRequirements,
} from "./never-dead-end-policy.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import type { CanonicalExecutorCapabilityVectorV1 } from "../shared/types.ts";
import { PLAYLIST_OPTIMIZER_POLICY_VERSION } from "./playlist-optimizer-v1.ts";

export const PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION =
  "playlist_contract_backend_capability_v6" as const;

function predicateOperators(
  predicate: PlaylistPredicateV1,
  output = new Set<string>(),
): Set<string> {
  output.add(predicate.op);
  if (predicate.op === "not") predicateOperators(predicate.child, output);
  else if (predicate.op === "except") {
    predicateOperators(predicate.base, output);
    predicate.exceptions.forEach((value) => predicateOperators(value, output));
  } else if (predicate.op === "alternative") {
    predicate.choices.forEach(({ predicate: value }) => predicateOperators(value, output));
  } else if (predicate.op === "all" || predicate.op === "any") {
    predicate.children.forEach((value) => predicateOperators(value, output));
  }
  return output;
}

function predicateClauseIds(
  predicate: PlaylistPredicateV1,
  output = new Set<string>(),
): Set<string> {
  if (predicate.op === "clause") output.add(predicate.clauseId);
  else if (predicate.op === "not") predicateClauseIds(predicate.child, output);
  else if (predicate.op === "except") {
    predicateClauseIds(predicate.base, output);
    predicate.exceptions.forEach((value) => predicateClauseIds(value, output));
  } else if (predicate.op === "alternative") {
    predicate.choices.forEach(({ predicate: value }) => predicateClauseIds(value, output));
  } else {
    predicate.children.forEach((value) => predicateClauseIds(value, output));
  }
  return output;
}

/**
 * Collect leaves whose raw positive assertion must be proven absent for the
 * complete predicate to pass. Clause-level exclusions invert the raw
 * assessment once; NOT and EXCEPT invert the Boolean branch again. Keeping
 * both pieces of polarity prevents a backend from claiming generic NOT
 * support when its evidence source is open-world.
 */
function negativePredicateRequirements(
  predicate: PlaylistPredicateV1,
  clauses: ReadonlyMap<string, PlaylistContractRevisionV1["clauses"][number]>,
  exactIdentityExclusionClauseIds: ReadonlySet<string>,
  output = new Set<string>(),
  negated = false,
): Set<string> {
  if (predicate.op === "clause") {
    const clause = clauses.get(predicate.clauseId);
    if (!clause) return output;
    const clauseExcludes = clause.kind === "exclusion"
      || clause.operator === "exclude";
    if (negated !== clauseExcludes) {
      output.add([
        clause.operator,
        clause.kind,
        clause.axis,
        ...(exactIdentityExclusionClauseIds.has(clause.id)
          ? ["exact_identity"]
          : []),
      ].join(":"));
    }
    return output;
  }
  if (predicate.op === "not") {
    return negativePredicateRequirements(
      predicate.child,
      clauses,
      exactIdentityExclusionClauseIds,
      output,
      !negated,
    );
  }
  if (predicate.op === "except") {
    negativePredicateRequirements(
      predicate.base,
      clauses,
      exactIdentityExclusionClauseIds,
      output,
      negated,
    );
    predicate.exceptions.forEach((value) => (
      negativePredicateRequirements(
        value,
        clauses,
        exactIdentityExclusionClauseIds,
        output,
        !negated,
      )
    ));
    return output;
  }
  if (predicate.op === "alternative") {
    predicate.choices.forEach(({ predicate: value }) => (
      negativePredicateRequirements(
        value,
        clauses,
        exactIdentityExclusionClauseIds,
        output,
        negated,
      )
    ));
    return output;
  }
  predicate.children.forEach((value) => (
    negativePredicateRequirements(
      value,
      clauses,
      exactIdentityExclusionClauseIds,
      output,
      negated,
    )
  ));
  return output;
}

function everyAnyIsSameAxisMembership(
  predicate: PlaylistPredicateV1,
  clauses: ReadonlyMap<string, PlaylistContractRevisionV1["clauses"][number]>,
): boolean {
  if (predicate.op === "any") {
    const members = predicate.children.flatMap((child) => {
      if (child.op !== "clause") return [];
      const clause = clauses.get(child.clauseId);
      return clause ? [clause] : [];
    });
    return members.length === predicate.children.length
      && members.length > 0
      && members.every((clause) => (
        clause.kind === "membership"
        && clause.scope === "track"
        && clause.hardness === "hard"
        && clause.operator === "require"
        && clause.axis === members[0]!.axis
      ));
  }
  if (predicate.op === "not") return everyAnyIsSameAxisMembership(predicate.child, clauses);
  if (predicate.op === "except") {
    return everyAnyIsSameAxisMembership(predicate.base, clauses)
      && predicate.exceptions.every((value) => everyAnyIsSameAxisMembership(value, clauses));
  }
  if (predicate.op === "alternative") {
    return predicate.choices.every(({ predicate: value }) => (
      everyAnyIsSameAxisMembership(value, clauses)
    ));
  }
  if (predicate.op === "all") {
    return predicate.children.every((value) => everyAnyIsSameAxisMembership(value, clauses));
  }
  return true;
}

function sorted<T extends string | number>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((left, right) => (
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right))
  ));
}

/**
 * Exact semantic features consumed by selection/publication for one immutable
 * contract. Discovery strategies are deliberately absent: they may broaden
 * their lead frontier, but they cannot reduce this selection requirement.
 */
export function playlistContractCapabilityRequirementsV1(
  contract: PlaylistContractRevisionV1,
): ContractCapabilityRequirements {
  assertPlaylistContractIntegrityV1(contract);
  const operators = predicateOperators(contract.trackPredicate);
  const byId = new Map(contract.clauses.map((clause) => [clause.id, clause]));
  const exactIdentityExclusionClauseIds = new Set(
    [
      ...(contract.executionDirectives?.similarity
        ?.exactArtistExclusionClauseIds ?? []),
      ...(contract.executionDirectives?.exactArtistIdentityExclusions
        ?.bindings.map(({ clauseId }) => clauseId) ?? []),
    ],
  );
  const negativeRequirements = negativePredicateRequirements(
    contract.trackPredicate,
    byId,
    exactIdentityExclusionClauseIds,
  );
  if (operators.has("any") && everyAnyIsSameAxisMembership(contract.trackPredicate, byId)) {
    operators.delete("any");
    operators.add("any_same_axis_membership");
  }
  const referencedClauseIds = predicateClauseIds(contract.trackPredicate);
  const quotaOperators = new Set<string>();
  const quotaClauseIds = new Set<string>();
  const quotaPredicateLeafShapes = new Set<string>();
  for (const quota of contract.playlistConstraints) {
    predicateOperators(quota.predicate).forEach((value) => {
      operators.add(value);
      quotaOperators.add(value);
    });
    predicateClauseIds(quota.predicate).forEach((value) => {
      referencedClauseIds.add(value);
      quotaClauseIds.add(value);
      const clause = byId.get(value);
      if (clause) {
        quotaPredicateLeafShapes.add([
          clause.operator,
          clause.kind,
          clause.scope,
          clause.hardness,
        ].join(":"));
      }
    });
    negativePredicateRequirements(
      quota.predicate,
      byId,
      exactIdentityExclusionClauseIds,
      negativeRequirements,
    );
    referencedClauseIds.add(quota.clauseId);
  }
  contract.qualityPolicy.centralSuitabilityClauseIds.forEach((value) => (
    referencedClauseIds.add(value)
  ));
  contract.sequencingObjectives.forEach(({ clauseId }) => referencedClauseIds.add(clauseId));

  const evidenceGrades = new Set<PlaylistContractEvidenceGradeV1>();
  const catalogPolicyAxes = new Set<string>();
  for (const id of referencedClauseIds) {
    const clause = byId.get(id);
    if (!clause) continue;
    clause.evidence.permittedGrades.forEach((grade) => evidenceGrades.add(grade));
    if (clause.evidence.minimumGrade) evidenceGrades.add(clause.evidence.minimumGrade);
    if (clause.kind === "catalog_version") catalogPolicyAxes.add(clause.axis);
  }
  const quotaAxes = [...quotaClauseIds].flatMap((id) => {
    const clause = byId.get(id);
    return clause ? [clause.axis] : [];
  });

  return {
    contractSchemaVersion: contract.schemaVersion,
    compilerVersion: contract.versions.compiler,
    ontologyVersion: contract.versions.ontology,
    evidencePolicyVersion: contract.versions.evidencePolicy,
    evidenceStrengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    questionTemplateVersion: contract.versions.questionTemplates,
    catalogPolicyVersion: contract.versions.catalogPolicy,
    locale: contract.locale,
    storefront: contract.storefront,
    predicateOperators: sorted(operators),
    negativePredicateRequirements: sorted(negativeRequirements),
    evidenceGrades: sorted(evidenceGrades),
    requiresQuotas: contract.playlistConstraints.length > 0,
    quotaPredicateOperators: sorted(quotaOperators),
    quotaAxes: sorted(quotaAxes),
    quotaPredicateLeafShapes: sorted(quotaPredicateLeafShapes),
    catalogPolicyAxes: sorted(catalogPolicyAxes),
    requiresSequencing: contract.sequencingObjectives.length > 0,
    sequencingDirections: sorted(contract.sequencingObjectives.map(({ direction }) => direction)),
    sequencingDimensions: sorted(contract.sequencingObjectives.map(({ dimension }) => dimension)),
    executionFeatures: sorted([
      ...(contract.executionDirectives?.fixedContainer
        ? ["fixed_container_identity_v1"]
        : []),
      ...(contract.executionDirectives?.fixedTrackList
        ? ["fixed_track_list_identity_v1"]
        : []),
      ...(contract.executionDirectives?.similarity
        ? ["similarity_seed_v1"]
        : []),
      ...((contract.executionDirectives?.similarity?.excludedArtists.length
        || contract.executionDirectives?.exactArtistIdentityExclusions
          ?.bindings.length)
        ? ["exact_artist_exclusion_v1"]
        : []),
    ]),
  };
}

/**
 * The only contract-3 executor currently shipped. This declaration is narrow
 * on purpose around playlist-wide adapters, while track eligibility executes
 * the complete tri-state Boolean tree from the immutable runtime projection.
 * Novel quota axes or sequencing dimensions still require a certified
 * playlist-wide optimizer.
 */
export const CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY:
Readonly<BackendCapabilityDeclaration> = Object.freeze({
  backend: "corpus_first_v3",
  contractSchemaVersions: [PLAYLIST_CONTRACT_SCHEMA_VERSION],
  compilerVersions: [
    PLAYLIST_CONTRACT_COMPILER_VERSION,
    PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION,
  ],
  ontologyVersions: [
    LEGACY_PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
    PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  ],
  evidencePolicyVersions: [
    PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION,
    PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION,
  ],
  evidenceStrengthPolicyVersions: [PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION],
  questionTemplateVersions: [PLAYLIST_CONTRACT_QUESTION_TEMPLATE_VERSION],
  catalogPolicyVersions: [PLAYLIST_CONTRACT_CATALOG_POLICY_VERSION],
  predicateOperators: [
    "clause",
    "all",
    "any",
    "any_same_axis_membership",
    "not",
    "except",
    "alternative",
  ],
  closedWorldNegativePredicates: [
    // These leaves are evaluated from complete Apple catalog facts, so a
    // non-match is selection-grade negative evidence.
    "require:catalog_version:content",
    "require:catalog_version:recording_version",
    "exclude:catalog_version:content",
    "exclude:catalog_version:recording_version",
    "exclude:exclusion:content",
    "exclude:exclusion:recording_version",
    // A typed similarity or standalone catalog-identity directive proves this
    // is an exact named-artist exclusion, not an open-ended semantic category.
    "exclude:exclusion:artist:exact_identity",
  ],
  evidenceGrades: [
    "authoritative_structured_metadata",
    "trusted_scoped_container",
    "track_specific_editorial_assertion",
    "primary_source",
    "independent_secondary_source",
    "model_derived_lead",
  ],
  supportsQuotas: true,
  // The current bridge projects one complete canonical leaf. More complex
  // quota predicates remain valid contracts but fail capability negotiation
  // before projection until a certified full-predicate adapter ships.
  quotaPredicateOperators: ["clause"],
  quotaPredicateLeafShapes: ["require:membership:track:hard"],
  quotaAxes: [
    "genre",
    "scene",
    "subgenre",
    "artist",
    "album",
    "track",
    "geography",
    "language",
    "era",
    "label",
    "venue",
  ],
  // Era constraints are evaluated fail-closed from recording-family release
  // evidence by pipeline-v3-era-policy and matching-service. Advertising the
  // axis is required for typed Guidance V4 year/range successors to reach that
  // certified evaluator instead of stopping before discovery.
  catalogPolicyAxes: ["storefront_availability", "recording_version", "content", "era"],
  supportsSequencing: true,
  sequencingDirections: ["ascending", "smooth", "contrast", "editorial"],
  sequencingDimensions: ["playlist_flow"],
  executionFeatures: [
    "fixed_container_identity_v1",
    "fixed_track_list_identity_v1",
    "similarity_seed_v1",
    "exact_artist_exclusion_v1",
  ],
  locales: "all",
  storefronts: "all",
});

export interface CanonicalExecutorCapabilityEnvelopeV1 {
  readonly hash: string;
  readonly vector: CanonicalExecutorCapabilityVectorV1;
}

/**
 * Bind backend semantics to the query-plan decoder that will consume them.
 * Schema 4 and schema 5 are intentionally distinct capabilities even when
 * every other backend declaration is identical.
 */
export function canonicalExecutorCapabilityForSchemaV1(input: {
  queryPlanSchemaVersion: number;
  backend?: BackendCapabilityDeclaration;
}): CanonicalExecutorCapabilityEnvelopeV1 {
  if (!Number.isSafeInteger(input.queryPlanSchemaVersion)
    || input.queryPlanSchemaVersion < 4) {
    throw new Error("canonical_executor_query_plan_schema_invalid");
  }
  const backend = input.backend ?? CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY;
  const vector: CanonicalExecutorCapabilityVectorV1 = {
    version: "canonical_executor_capability_vector_v1",
    queryPlanSchemaVersion: input.queryPlanSchemaVersion,
    backendCapabilityVersion: PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION,
    playlistOptimizerPolicyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
    backend: backend.backend,
    backendDeclaration: structuredClone(
      backend as unknown as Record<string, unknown>,
    ),
  };
  return Object.freeze({
    hash: sha256Hex(stableStringify(vector)),
    vector: Object.freeze(vector),
  });
}

export function canonicalExecutorCapabilityEnvelopeIsValidV1(
  value: unknown,
): value is CanonicalExecutorCapabilityEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<CanonicalExecutorCapabilityEnvelopeV1>;
  if (typeof row.hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.hash)
    || !row.vector || typeof row.vector !== "object"
    || row.vector.version !== "canonical_executor_capability_vector_v1"
    || !Number.isSafeInteger(row.vector.queryPlanSchemaVersion)
    || row.vector.queryPlanSchemaVersion < 4
    || typeof row.vector.backendCapabilityVersion !== "string"
    || row.vector.playlistOptimizerPolicyVersion !== PLAYLIST_OPTIMIZER_POLICY_VERSION
    || typeof row.vector.backend !== "string"
    || !row.vector.backendDeclaration
    || typeof row.vector.backendDeclaration !== "object"
    || Array.isArray(row.vector.backendDeclaration)) return false;
  return sha256Hex(stableStringify(row.vector)) === row.hash;
}

export interface PlaylistContractBackendNegotiationV1 {
  readonly backend: BackendCapabilityDeclaration | null;
  readonly result: BackendCapabilityResult;
  readonly requirements: ContractCapabilityRequirements;
  /** Safe to persist or expose in release evidence; it contains no prompt/user data. */
  readonly capabilityHash: string | null;
}

export function negotiatePlaylistContractBackendV1(input: {
  contract: PlaylistContractRevisionV1;
  backends: readonly BackendCapabilityDeclaration[];
}): PlaylistContractBackendNegotiationV1 {
  const requirements = playlistContractCapabilityRequirementsV1(input.contract);
  const attempts = input.backends.map((backend) => ({
    backend,
    result: backendSupportsContract(backend, requirements),
  }));
  const selected = attempts.find(({ result }) => result.supported) ?? null;
  if (!selected) {
    return {
      backend: null,
      result: {
        supported: false,
        missing: sorted(attempts.flatMap(({ backend, result }) => (
          result.missing.map((reason) => `${backend.backend}:${reason}`)
        ))),
      },
      requirements,
      capabilityHash: null,
    };
  }
  return {
    backend: selected.backend,
    result: selected.result,
    requirements,
    capabilityHash: sha256Hex(stableStringify({
      capabilityVersion: PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION,
      backend: selected.backend,
    })),
  };
}

export function assertPlaylistContractBackendSupportedV1(input: {
  contract: PlaylistContractRevisionV1;
  backend?: BackendCapabilityDeclaration;
}): PlaylistContractBackendNegotiationV1 {
  const negotiation = negotiatePlaylistContractBackendV1({
    contract: input.contract,
    backends: [input.backend ?? CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
  });
  if (!negotiation.backend || !negotiation.result.supported) {
    throw new Error(
      `playlist_contract_backend_unsupported:${negotiation.result.missing.join(",")}`,
    );
  }
  return negotiation;
}
