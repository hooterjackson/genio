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
import { PLAYLIST_CONTRACT_ONTOLOGY_VERSION } from "./music-concept-registry-v1.ts";
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

export const PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION =
  "playlist_contract_backend_capability_v2" as const;

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
  if (operators.has("any") && everyAnyIsSameAxisMembership(contract.trackPredicate, byId)) {
    operators.delete("any");
    operators.add("any_same_axis_membership");
  }
  const referencedClauseIds = predicateClauseIds(contract.trackPredicate);
  const quotaOperators = new Set<string>();
  const quotaClauseIds = new Set<string>();
  for (const quota of contract.playlistConstraints) {
    predicateOperators(quota.predicate).forEach((value) => {
      operators.add(value);
      quotaOperators.add(value);
    });
    predicateClauseIds(quota.predicate).forEach((value) => {
      referencedClauseIds.add(value);
      quotaClauseIds.add(value);
    });
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
    evidenceGrades: sorted(evidenceGrades),
    requiresQuotas: contract.playlistConstraints.length > 0,
    quotaPredicateOperators: sorted(quotaOperators),
    quotaAxes: sorted(quotaAxes),
    catalogPolicyAxes: sorted(catalogPolicyAxes),
    requiresSequencing: contract.sequencingObjectives.length > 0,
    sequencingDirections: sorted(contract.sequencingObjectives.map(({ direction }) => direction)),
    sequencingDimensions: sorted(contract.sequencingObjectives.map(({ dimension }) => dimension)),
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
  ontologyVersions: [PLAYLIST_CONTRACT_ONTOLOGY_VERSION],
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
  evidenceGrades: [
    "authoritative_structured_metadata",
    "trusted_scoped_container",
    "track_specific_editorial_assertion",
    "primary_source",
    "independent_secondary_source",
    "model_derived_lead",
  ],
  supportsQuotas: true,
  quotaPredicateOperators: ["clause", "all", "any", "not", "except", "alternative"],
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
  catalogPolicyAxes: ["storefront_availability", "recording_version", "content"],
  supportsSequencing: true,
  sequencingDirections: ["ascending", "smooth", "contrast", "editorial"],
  sequencingDimensions: ["playlist_flow"],
  locales: "all",
  storefronts: "all",
});

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
