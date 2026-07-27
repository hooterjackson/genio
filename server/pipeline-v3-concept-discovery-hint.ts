import type {
  PipelineV3ConceptDiscoveryHint,
  QueryPlanV3,
} from "../shared/types.ts";
import {
  PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  normalizeMusicConceptTextV1,
  resolveMusicConceptV1,
  type MusicConceptKindV1,
} from "./music-concept-registry-v1.ts";

export const PIPELINE_V3_CONCEPT_DISCOVERY_HINT_PROVENANCE =
  "immutable_playlist_contract_concept_v1" as const;
export const PIPELINE_V3_CONCEPT_DISCOVERY_HINT_USAGE =
  "discovery_lead_only_not_membership_evidence_or_ranking" as const;
export const PIPELINE_V3_MAX_CONCEPT_DISCOVERY_HINTS = 24;

const HINT_KEYS = [
  "axis",
  "clauseId",
  "normalizedText",
  "ontologyVersion",
  "originalText",
  "provenance",
  "status",
  "unresolvedTermId",
  "untrusted",
  "usage",
] as const;

function expectedConceptKind(axis: string): MusicConceptKindV1 | null {
  if (axis === "subgenre") return "genre";
  return [
    "genre",
    "scene",
    "theme",
    "mood",
    "activity",
    "artist",
    "geography",
    "language",
  ].includes(axis)
    ? axis as MusicConceptKindV1
    : null;
}

export function pipelineV3ConceptDiscoveryHintKey(
  hint: Pick<PipelineV3ConceptDiscoveryHint, "axis" | "normalizedText">,
): string {
  return `${hint.axis}\u0000${hint.normalizedText}`;
}

export function clonePipelineV3ConceptDiscoveryHints(
  hints: readonly PipelineV3ConceptDiscoveryHint[] | null | undefined,
): PipelineV3ConceptDiscoveryHint[] {
  return (hints ?? []).map((hint) => ({ ...hint }));
}

/**
 * Returns all query-plan clause ids which already have executable semantics.
 * Concept discovery hints must never share one of these identities.
 */
type ExecutableQueryPlanProjectionV3 = {
  readonly membershipPredicates: readonly QueryPlanV3["membershipPredicates"][number][];
  readonly rankingObjectives: readonly QueryPlanV3["rankingObjectives"][number][];
  readonly semanticClauses?: readonly NonNullable<QueryPlanV3["semanticClauses"]>[number][];
  readonly hardConstraints: readonly QueryPlanV3["hardConstraints"][number][];
  readonly softPreferences: readonly QueryPlanV3["softPreferences"][number][];
  readonly canonicalContractPolicy?: QueryPlanV3["canonicalContractPolicy"];
  readonly playlistQuotaRules?: readonly NonNullable<QueryPlanV3["playlistQuotaRules"]>[number][];
  readonly playlistQualityPolicy?: QueryPlanV3["playlistQualityPolicy"];
};

export function executableQueryPlanClauseIdsV3(
  plan: ExecutableQueryPlanProjectionV3,
): Set<string> {
  const membershipPredicates = Array.isArray(plan.membershipPredicates)
    ? plan.membershipPredicates
    : [];
  const rankingObjectives = Array.isArray(plan.rankingObjectives)
    ? plan.rankingObjectives
    : [];
  const semanticClauses = Array.isArray(plan.semanticClauses)
    ? plan.semanticClauses
    : [];
  const hardConstraints = Array.isArray(plan.hardConstraints)
    ? plan.hardConstraints
    : [];
  const softPreferences = Array.isArray(plan.softPreferences)
    ? plan.softPreferences
    : [];
  const canonicalClauses = Array.isArray(plan.canonicalContractPolicy?.clauses)
    ? plan.canonicalContractPolicy.clauses
    : [];
  const quotaRules = Array.isArray(plan.playlistQuotaRules)
    ? plan.playlistQuotaRules
    : [];
  const qualityClauseIds = Array.isArray(plan.playlistQualityPolicy?.clauseIds)
    ? plan.playlistQualityPolicy.clauseIds
    : [];
  return new Set([
    ...membershipPredicates.map(({ id }) => id),
    ...rankingObjectives.map(({ id }) => id),
    ...semanticClauses.map(({ id }) => id),
    ...hardConstraints.map(({ id }) => id),
    ...softPreferences.map(({ id }) => id),
    ...canonicalClauses.map(({ id }) => id),
    ...quotaRules.flatMap(({ id, clauseId }) => [id, clauseId]),
    ...qualityClauseIds,
  ]);
}

export function isPipelineV3ConceptDiscoveryHints(
  value: unknown,
  executableClauseIds: ReadonlySet<string> = new Set(),
): value is PipelineV3ConceptDiscoveryHint[] {
  if (!Array.isArray(value) || value.length > PIPELINE_V3_MAX_CONCEPT_DISCOVERY_HINTS) {
    return false;
  }
  const seen = new Set<string>();
  let previousKey: string | null = null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const hint = item as Partial<PipelineV3ConceptDiscoveryHint>;
    if (Object.keys(item).sort().join("\u0000") !== [...HINT_KEYS].sort().join("\u0000")
      || typeof hint.clauseId !== "string"
      || !/^[A-Za-z0-9._:-]{1,160}$/u.test(hint.clauseId)
      || executableClauseIds.has(hint.clauseId)
      || typeof hint.axis !== "string"
      || !/^[a-z][a-z0-9_-]{0,119}$/u.test(hint.axis)
      || typeof hint.originalText !== "string"
      || hint.originalText.length < 1
      || hint.originalText.length > 500
      || hint.originalText !== hint.originalText.normalize("NFKC").replace(/\s+/gu, " ").trim()
      || typeof hint.normalizedText !== "string"
      || hint.normalizedText !== normalizeMusicConceptTextV1(hint.originalText)
      || hint.normalizedText.length < 1
      || hint.normalizedText.length > 500
      || !["discovery_only", "unresolved"].includes(String(hint.status))
      || hint.ontologyVersion !== PLAYLIST_CONTRACT_ONTOLOGY_VERSION
      || hint.provenance !== PIPELINE_V3_CONCEPT_DISCOVERY_HINT_PROVENANCE
      || hint.untrusted !== true
      || hint.usage !== PIPELINE_V3_CONCEPT_DISCOVERY_HINT_USAGE) {
      return false;
    }
    let resolved;
    try {
      resolved = resolveMusicConceptV1({
        text: hint.originalText,
        expectedKind: expectedConceptKind(hint.axis),
      });
    } catch {
      return false;
    }
    if (resolved.status !== hint.status
      || resolved.ontologyVersion !== hint.ontologyVersion
      || resolved.normalizedText !== hint.normalizedText
      || resolved.unresolvedTermId !== hint.unresolvedTermId
      || resolved.discoveryHint !== hint.originalText) {
      return false;
    }
    const key = pipelineV3ConceptDiscoveryHintKey(
      hint as PipelineV3ConceptDiscoveryHint,
    );
    if (seen.has(key) || (previousKey !== null && previousKey.localeCompare(key) > 0)) {
      return false;
    }
    seen.add(key);
    previousKey = key;
  }
  return true;
}

export function assertPipelineV3ConceptDiscoveryHints(
  value: unknown,
  executableClauseIds: ReadonlySet<string> = new Set(),
): asserts value is PipelineV3ConceptDiscoveryHint[] {
  if (!isPipelineV3ConceptDiscoveryHints(value, executableClauseIds)) {
    throw new Error("invalid_pipeline_v3_concept_discovery_hints");
  }
}
