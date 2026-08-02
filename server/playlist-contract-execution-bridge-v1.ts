import type {
  CanonicalPlaylistContractExecutionPolicyV1,
  CanonicalPlaylistContractPredicateV1,
  CanonicalPlaylistQualityPolicy,
  CanonicalPlaylistQuotaRule,
  PipelineV3ConceptDiscoveryHint,
  SelectionConstraint,
  SelectionConstraintAxis,
  SelectionPlan,
} from "../shared/types.ts";
import type {
  ResearchArchetype,
  ResearchIntent,
  SelectionDiversityGoals,
  SelectionGeographyConstraint,
  SelectionOrderingPolicy,
  SelectionScopeKind,
} from "../shared/types.ts";
import {
  assertPlaylistContractIntegrityV1,
  type PlaylistContractClauseV1,
  type PlaylistContractRevisionV1,
  type PlaylistPredicateV1,
} from "./playlist-contract-v1.ts";
import {
  PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION,
  assertPlaylistContractBackendSupportedV1,
} from "./playlist-contract-backend-capability-v1.ts";
import { canonicalContractExecutionPolicyV1 } from "./canonical-contract-runtime-v1.ts";
import type { BackendCapabilityDeclaration } from "./never-dead-end-policy.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import {
  MUSIC_CONCEPT_POLICY_VERSION,
} from "./music-concepts-v3.ts";
import {
  PIPELINE_V3_CONCEPT_DISCOVERY_HINT_PROVENANCE,
  PIPELINE_V3_CONCEPT_DISCOVERY_HINT_USAGE,
  PIPELINE_V3_MAX_CONCEPT_DISCOVERY_HINTS,
  assertPipelineV3ConceptDiscoveryHints,
  pipelineV3ConceptDiscoveryHintKey,
} from "./pipeline-v3-concept-discovery-hint.ts";
import {
  PIPELINE_V3_VERSION,
  SEMANTIC_PLAN_V3_1_VERSION,
  SEMANTIC_SCOPE_POLICY_VERSION,
  SELECTION_PLAN_V3_SCHEMA_VERSION,
  SELECTION_PLAN_V3_VERSION,
  deepFreeze,
  type IntentEngineV3,
  type IntentV3,
  type MembershipAxisV3,
  type MembershipPredicateV3,
  type RankingObjectiveV3,
  type SemanticPlanClauseV32,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";

export const PLAYLIST_CONTRACT_EXECUTION_BRIDGE_VERSION =
  "playlist_contract_execution_bridge_v1" as const;

const EXECUTABLE_MEMBERSHIP_AXES = new Set<SelectionConstraintAxis>([
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
]);

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const clean = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const key = clean.toLocaleLowerCase("en-US");
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [clean];
  });
}

function executableClauseValues(clause: PlaylistContractClauseV1): string[] {
  return unique([
    ...clause.values,
    ...clause.concepts.flatMap((concept) => {
      if (concept.status !== "resolved" || !concept.selectedConceptId) return [];
      const selected = concept.candidates.find(
        (candidate) => candidate.conceptId === concept.selectedConceptId,
      );
      return [selected?.label ?? concept.originalText];
    }),
  ]);
}

function predicateClauseIds(
  predicate: PlaylistPredicateV1,
  unsupported: Set<PlaylistPredicateV1["op"]>,
): string[] {
  if (predicate.op === "clause") return [predicate.clauseId];
  if (predicate.op === "all" || predicate.op === "any") {
    return predicate.children.flatMap((child) => predicateClauseIds(child, unsupported));
  }
  unsupported.add(predicate.op);
  if (predicate.op === "not") return predicateClauseIds(predicate.child, unsupported);
  if (predicate.op === "except") {
    return [
      ...predicateClauseIds(predicate.base, unsupported),
      ...predicate.exceptions.flatMap((child) => predicateClauseIds(child, unsupported)),
    ];
  }
  if (predicate.op === "alternative") {
    return predicate.choices.flatMap((choice) => predicateClauseIds(choice.predicate, unsupported));
  }
  throw new Error("unsupported_contract_predicate");
}

function executableAxis(clause: PlaylistContractClauseV1): SelectionConstraintAxis {
  if (!EXECUTABLE_MEMBERSHIP_AXES.has(clause.axis as SelectionConstraintAxis)) {
    throw new Error(`unsupported_contract_membership_axis:${clause.axis}`);
  }
  return clause.axis as SelectionConstraintAxis;
}

function quotaRules(
  contract: PlaylistContractRevisionV1,
): CanonicalPlaylistQuotaRule[] {
  const clauses = new Map(contract.clauses.map((clause) => [clause.id, clause]));
  return contract.playlistConstraints.map((quota) => {
    const unsupported = new Set<PlaylistPredicateV1["op"]>();
    const clauseIds = predicateClauseIds(quota.predicate, unsupported);
    const predicateClause = clauseIds
      .map((id) => clauses.get(id))
      .find((clause) => clause?.scope === "track");
    if (!predicateClause
      || predicateClause.kind !== "membership"
      || predicateClause.scope !== "track"
      || predicateClause.hardness !== "hard"
      || predicateClause.operator !== "require") {
      throw new Error(`unsupported_contract_quota_clause:${quota.id}`);
    }
    const axis = executableAxis(predicateClause);
    const evidenceGrade = predicateClause.evidence.minimumGrade
      ?? predicateClause.evidence.permittedGrades[0]
      ?? "authoritative_structured_metadata";
    return {
      id: quota.id,
      clauseId: predicateClause.id,
      axis,
      values: executableClauseValues(predicateClause),
      minimumCount: quota.minimumCount,
      maximumCount: quota.maximumCount,
      minimumRatio: quota.minimumRatio,
      maximumRatio: quota.maximumRatio,
      evidenceGrade,
      predicate: structuredClone(quota.predicate) as CanonicalPlaylistContractPredicateV1,
    };
  });
}

function centralQualityPolicy(
  contract: PlaylistContractRevisionV1,
): CanonicalPlaylistQualityPolicy | null {
  const clauses = new Map(contract.clauses.map((clause) => [clause.id, clause]));
  const qualityClauses = contract.qualityPolicy.centralSuitabilityClauseIds.map((id) => {
    const clause = clauses.get(id);
    if (!clause
      || clause.kind !== "suitability"
      || clause.scope !== "track"
      || clause.hardness !== "soft"
      || clause.operator !== "prefer") {
      throw new Error(`unsupported_contract_quality_clause:${id}`);
    }
    return clause;
  });
  if (qualityClauses.length === 0) return null;
  const criteria = unique(qualityClauses.flatMap(executableClauseValues));
  if (criteria.length === 0) throw new Error("empty_contract_quality_criteria");
  return {
    policyVersion: "canonical_central_quality_v1",
    clauseIds: qualityClauses.map(({ id }) => id),
    criteria,
    minimumPassRatio: contract.qualityPolicy.minimumPassRatio,
    maximumUnknownRatio: contract.qualityPolicy.maximumUnknownRatio,
    zeroKnownFailures: true,
    signalDimension: "central_quality",
    passThreshold: 0.75,
    failThreshold: 0.4,
    signalSemantics: "ranking_only_not_factual_evidence",
  };
}

const V3_MEMBERSHIP_AXES = new Set<MembershipAxisV3>([
  "genre",
  "subgenre",
  "scene",
  "era",
  "geography",
  "language",
  "theme",
  "mood",
  "activity",
  "artist",
  "album",
  "playlist",
  "track",
  "label",
  "venue",
  "factual_relationship",
  "recording_version",
  "content",
]);

function geographyRelationshipFor(
  values: readonly string[],
): SelectionConstraint["geographyRelationship"] {
  const marker = values.find((value) => value.startsWith("relationship:"));
  const relationship = marker?.slice("relationship:".length);
  return [
    "artist_origin",
    "artist_residence",
    "recording_location",
    "label_or_venue_scene",
    "language",
    "sound_association",
    "unspecified",
  ].includes(relationship ?? "")
    ? relationship as NonNullable<SelectionConstraint["geographyRelationship"]>
    : "unspecified";
}

function executionValues(clause: PlaylistContractClauseV1): string[] {
  return executableClauseValues(clause).filter((value) => !value.startsWith("relationship:"));
}

function membershipAxis(clause: PlaylistContractClauseV1): MembershipAxisV3 | null {
  const axis = clause.kind === "factual_relationship" || clause.axis === "relationship"
    ? "factual_relationship"
    : clause.axis;
  return V3_MEMBERSHIP_AXES.has(axis as MembershipAxisV3)
    ? axis as MembershipAxisV3
    : null;
}

function canonicalMembershipPredicates(
  contract: PlaylistContractRevisionV1,
): MembershipPredicateV3[] {
  const referenced = new Set(predicateClauseIds(contract.trackPredicate, new Set()));
  contract.playlistConstraints.forEach(({ predicate }) => {
    predicateClauseIds(predicate, new Set()).forEach((id) => referenced.add(id));
  });
  return contract.clauses.flatMap((clause): MembershipPredicateV3[] => {
    if (!referenced.has(clause.id) || clause.scope !== "track" || clause.hardness !== "hard") return [];
    const axis = membershipAxis(clause);
    const values = executionValues(clause);
    if (!axis || values.length === 0
      || ["storefront_availability", "evidence"].includes(clause.axis)) return [];
    return [{
      id: clause.id,
      axis,
      operator: clause.kind === "exclusion" || clause.operator === "exclude"
        ? "exclude"
        : "require",
      values,
      source: clause.source.provenance === "guidance"
        ? "guided_answer"
        : clause.source.provenance === "system_default"
          ? "system_safety"
          : "user",
      geographyRelationship: axis === "geography"
        ? geographyRelationshipFor(clause.values)
        : null,
      reason: `Canonical contract clause ${clause.id}.`,
    }];
  });
}

function canonicalSemanticClauses(
  predicates: readonly MembershipPredicateV3[],
): SemanticPlanClauseV32[] {
  return predicates.map((predicate) => ({
    id: predicate.id,
    role: predicate.axis === "recording_version" || predicate.axis === "content"
      ? "catalog_policy"
      : "membership",
    axis: predicate.axis,
    operator: predicate.operator,
    values: [...predicate.values],
    source: predicate.source === "guided_answer"
      ? "guided_answer"
      : predicate.source === "user"
        ? "raw_prompt"
        : "system_default",
    explicitUserAuthored: predicate.source !== "system_safety",
    geographyRelationship: predicate.geographyRelationship ?? null,
    reason: predicate.reason,
  }));
}

function canonicalEngines(
  contract: PlaylistContractRevisionV1,
  predicates: readonly MembershipPredicateV3[],
): IntentEngineV3[] {
  const axes = new Set(predicates.map(({ axis }) => axis));
  const engines = new Set<IntentEngineV3>();
  if (contract.executionDirectives?.fixedContainer
    || contract.executionDirectives?.fixedTrackList) {
    engines.add("fixed_container");
  }
  if (axes.has("factual_relationship")) engines.add("factual_relationship");
  if (axes.has("artist") && axes.size === 1) engines.add("artist_catalogue");
  if ([...axes].some((axis) => ["mood", "activity", "theme"].includes(axis))) {
    engines.add("mood_activity_theme");
  }
  // Contract 3 intentionally moves subjective mood/activity requirements out
  // of the hard per-track predicate and into the playlist-level central
  // suitability floor. They still require the mood/activity execution lane;
  // deriving engines only from hard membership axes silently dropped that
  // lane for requests such as "dark ambient for sleep".
  const centralSuitabilityAxes = new Set(
    contract.qualityPolicy.centralSuitabilityClauseIds.flatMap((id) => {
      const clause = contract.clauses.find((candidate) => candidate.id === id);
      return clause ? [clause.axis] : [];
    }),
  );
  if ([...centralSuitabilityAxes].some((axis) => (
    ["mood", "activity", "theme", "central_suitability"].includes(axis)
  ))) {
    engines.add("mood_activity_theme");
  }
  if ([...axes].some((axis) => ["genre", "subgenre", "scene", "geography", "language"].includes(axis))) {
    engines.add("curated_genre_scene");
  }
  if (contract.executionDirectives?.similarity) engines.add("similarity");
  if (engines.size === 0) engines.add("curated_genre_scene");
  return [...engines];
}

function intentsForEngines(engines: readonly IntentEngineV3[]): IntentV3[] {
  const output = new Set<IntentV3>();
  engines.forEach((engine) => {
    if (engine === "curated_genre_scene") output.add("genre_scene");
    if (engine === "mood_activity_theme") output.add("mood_activity");
    if (engine === "similarity") output.add("similarity");
    if (engine === "artist_catalogue") output.add("artist_catalogue");
    if (engine === "factual_relationship") output.add("factual_relationship");
    if (engine === "exhaustive") output.add("exhaustive");
  });
  if (output.size === 0) output.add("genre_scene");
  return [...output];
}

function canonicalScopeKind(
  contract: PlaylistContractRevisionV1,
  engines: readonly IntentEngineV3[],
): SelectionScopeKind {
  if (contract.executionDirectives?.fixedTrackList) return "fixed_track_list";
  if (engines.includes("fixed_container")) return "fixed_release_container";
  if (engines.includes("artist_catalogue")) return "artist_catalogue";
  if (engines.includes("factual_relationship") || engines.includes("exhaustive")) {
    return "factual_frontier";
  }
  return "broad_curated";
}

function canonicalDiversityGoals(
  contract: PlaylistContractRevisionV1,
): SelectionDiversityGoals {
  const values: SelectionDiversityGoals = {
    minimumDistinctArtists: null,
    minimumDistinctAlbums: null,
    minimumDistinctEras: null,
    minimumDistinctScenes: null,
    minimumDistinctGeographies: null,
    maximumTracksPerArtist: null,
    maximumTracksPerAlbum: null,
  };
  const axes: Array<[PlaylistContractClauseV1["axis"], keyof SelectionDiversityGoals]> = [
    ["minimum-distinct-artists", "minimumDistinctArtists"],
    ["minimum-distinct-albums", "minimumDistinctAlbums"],
    ["minimum-distinct-eras", "minimumDistinctEras"],
    ["minimum-distinct-scenes", "minimumDistinctScenes"],
    ["minimum-distinct-geographies", "minimumDistinctGeographies"],
    ["maximum-tracks-per-artist", "maximumTracksPerArtist"],
    ["maximum-tracks-per-album", "maximumTracksPerAlbum"],
  ];
  for (const [axis, key] of axes) {
    const clause = contract.clauses.find((value) => value.axis === axis);
    // Soft diversity clauses are optimization preferences. Treating the
    // migration defaults as immutable minimums manufactured infeasibility
    // whenever the evidence graph did not expose that taxonomy (notably
    // minimum-distinct-scenes:0/2). Only an explicitly hard contract clause
    // may block exact publication.
    if (clause?.hardness !== "hard") continue;
    const count = Number(clause?.values[0]);
    if (Number.isSafeInteger(count) && count >= 0) values[key] = count;
  }
  return values;
}

function canonicalOrderingPolicy(
  contract: PlaylistContractRevisionV1,
): SelectionOrderingPolicy {
  const objective = [...contract.sequencingObjectives]
    .sort((left, right) => left.priority - right.priority)[0];
  const mode: SelectionOrderingPolicy["mode"] = objective?.direction === "smooth"
    ? "smooth"
    : objective?.direction === "contrast"
      ? "contrast"
      : objective?.direction === "ascending"
        ? "chronological"
        : "editorial";
  const clause = objective
    ? contract.clauses.find(({ id }) => id === objective.clauseId)
    : null;
  const goals = clause ? executionValues(clause) : [];
  const sourceOrdered = [
    ...goals,
    clause?.source.text ?? "",
  ].some((value) => (
    /\b(?:source[_ -]?order|keep (?:the )?source order)\b/iu.test(value.trim())
  ));
  const resolvedMode: SelectionOrderingPolicy["mode"] =
    contract.executionDirectives?.fixedTrackList || sourceOrdered
    ? "source_order"
    : mode;
  return {
    mode: resolvedMode,
    goals,
    avoidAdjacentSameArtist: goals.some((value) => /avoid adjacent same artist/iu.test(value)),
    avoidAdjacentSameAlbum: goals.some((value) => /avoid adjacent same album/iu.test(value)),
  };
}

function canonicalRecordingPolicy(): SelectionPlanV3["recordingPolicy"] {
  // Catalog/version clauses remain leaves of canonicalContractPolicy. This
  // compatibility field is deliberately permissive so nested OR/NOT/EXCEPT
  // leaves cannot be flattened into a second unconditional gate.
  return {
    allowedVersions: [
    "canonical", "clean", "explicit", "live", "remix", "radio_edit",
    "extended", "acoustic", "instrumental",
    ],
    preferCanonicalStudio: false,
    excludeKaraokeTributeAndCovers: false,
  };
}

function canonicalRankingObjectives(
  contract: PlaylistContractRevisionV1,
  qualityPolicy: CanonicalPlaylistQualityPolicy | null,
): RankingObjectiveV3[] {
  const objectives: RankingObjectiveV3[] = [{
    id: "canonical:ranking:relevance",
    dimension: "relevance",
    direction: "maximize",
    weight: 1,
    relaxationRank: null,
    values: [],
    reason: "Rank only after canonical eligibility succeeds.",
  }];
  const sequencingClauseIds = new Set(
    contract.sequencingObjectives.map(({ clauseId }) => clauseId),
  );
  for (const clause of contract.clauses) {
    if (clause.hardness !== "soft"
      || !["ranking_preference", "suitability"].includes(clause.kind)
      || contract.qualityPolicy.centralSuitabilityClauseIds.includes(clause.id)
      || sequencingClauseIds.has(clause.id)) continue;
    const dimension: RankingObjectiveV3["dimension"] =
      clause.axis === "similarity" ? "similarity"
        : clause.axis === "influence" ? "influence"
          : clause.axis === "artist_diversity" ? "artist_diversity"
            : clause.axis === "album_diversity" ? "album_diversity"
              : clause.axis === "era_balance" ? "era_balance"
                : clause.axis === "scene_balance" ? "scene_balance"
                  : clause.axis === "geography_balance" ? "geography_balance"
                    : "relevance";
    objectives.push({
      id: clause.id,
      dimension,
      direction: "maximize",
      weight: 0.8,
      relaxationRank: 1,
      values: executionValues(clause),
      reason: `Canonical ranking preference ${clause.id} (${clause.axis}).`,
    });
  }
  if (qualityPolicy) {
    objectives.push({
      id: "canonical:ranking:central-quality",
      dimension: "central_quality",
      direction: "maximize",
      weight: 1,
      relaxationRank: null,
      values: [...qualityPolicy.criteria],
      reason: "Apply the immutable central suitability objective.",
    });
  }
  contract.sequencingObjectives.forEach((objective) => {
    objectives.push({
      id: objective.id,
      dimension: "sequencing",
      direction: "maximize",
      weight: objective.weight,
      relaxationRank: objective.priority,
      values: [objective.dimension, objective.direction],
      reason: `Canonical sequencing objective ${objective.id}.`,
    });
  });
  return objectives;
}

/**
 * Keep rollout/executor intent ownership derived from the same canonical
 * objectives that the worker consumes. Historical influence is a ranking
 * objective rather than a membership engine, so deriving intents from hard
 * predicate engines alone would silently move an accepted editorial request
 * into the generic genre cohort after guidance created its successor
 * contract.
 */
function canonicalExecutionIntents(
  engines: readonly IntentEngineV3[],
  rankingObjectives: readonly RankingObjectiveV3[],
): IntentV3[] {
  const intents = new Set<IntentV3>(intentsForEngines(engines));
  if (rankingObjectives.some(({ dimension }) => dimension === "influence")) {
    intents.add("editorial_ranking");
  }
  return [...intents];
}

/**
 * Preserve only non-resolved concepts whose clause has no executable role.
 * These values may widen discovery, but never enter a predicate, evidence
 * obligation, ranking objective, quota, quality floor, or sequencing rule.
 */
function canonicalConceptDiscoveryHints(
  contract: PlaylistContractRevisionV1,
): PipelineV3ConceptDiscoveryHint[] {
  const executableClauseIds = new Set(
    predicateClauseIds(contract.trackPredicate, new Set()),
  );
  contract.playlistConstraints.forEach(({ clauseId, predicate }) => {
    executableClauseIds.add(clauseId);
    predicateClauseIds(predicate, new Set()).forEach((id) => executableClauseIds.add(id));
  });
  contract.sequencingObjectives.forEach(({ clauseId }) => executableClauseIds.add(clauseId));
  contract.qualityPolicy.centralSuitabilityClauseIds.forEach((id) => (
    executableClauseIds.add(id)
  ));
  for (const clause of contract.clauses) {
    if (clause.kind === "ranking_preference" || clause.kind === "suitability") {
      executableClauseIds.add(clause.id);
    }
  }

  const byKey = new Map<string, PipelineV3ConceptDiscoveryHint>();
  for (const clause of contract.clauses) {
    if (executableClauseIds.has(clause.id)) continue;
    for (const concept of clause.concepts) {
      if (concept.status !== "discovery_only" && concept.status !== "unresolved") continue;
      const hint: PipelineV3ConceptDiscoveryHint = {
        clauseId: clause.id,
        axis: clause.axis,
        originalText: concept.originalText,
        normalizedText: concept.normalizedText,
        status: concept.status,
        ontologyVersion: concept.ontologyVersion,
        unresolvedTermId: concept.unresolvedTermId,
        provenance: PIPELINE_V3_CONCEPT_DISCOVERY_HINT_PROVENANCE,
        untrusted: true,
        usage: PIPELINE_V3_CONCEPT_DISCOVERY_HINT_USAGE,
      };
      const key = pipelineV3ConceptDiscoveryHintKey(hint);
      if (!byKey.has(key)) byKey.set(key, hint);
    }
  }
  const hints = [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, PIPELINE_V3_MAX_CONCEPT_DISCOVERY_HINTS)
    .map(([, hint]) => hint);
  assertPipelineV3ConceptDiscoveryHints(hints, executableClauseIds);
  return hints;
}

function canonicalSelectionPlanV3(input: {
  contract: PlaylistContractRevisionV1;
  policy: CanonicalPlaylistContractExecutionPolicyV1;
  quotaRules: readonly CanonicalPlaylistQuotaRule[];
  qualityPolicy: CanonicalPlaylistQualityPolicy | null;
}): SelectionPlanV3 {
  const predicates = canonicalMembershipPredicates(input.contract);
  const semantic = canonicalSemanticClauses(predicates);
  const semanticClauses = semantic;
  const catalogPolicies = semantic.filter(({ role }) => role === "catalog_policy");
  const engines = canonicalEngines(input.contract, predicates);
  const rankingObjectives = canonicalRankingObjectives(
    input.contract,
    input.qualityPolicy,
  );
  const intents = canonicalExecutionIntents(engines, rankingObjectives);
  const scopeKind = canonicalScopeKind(input.contract, engines);
  const summary = input.policy.clauses
    .map((clause) => `${clause.axis} ${clause.operator} ${clause.values.join(" or ")}`)
    .join("; ")
    .slice(0, 4_000);
  const hardConstraintHash = sha256Hex(stableStringify({
    policyProjectionHash: input.policy.projectionHash,
    semanticClauses,
    catalogPolicies,
  }));
  return deepFreeze({
    schemaVersion: SELECTION_PLAN_V3_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_V3_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    prompt: summary,
    requestedTrackCount: input.contract.requestedTrackCount,
    storefront: input.contract.storefront,
    intents,
    engines,
    membershipPredicates: predicates.filter((predicate) => (
      predicate.axis !== "recording_version" && predicate.axis !== "content"
    )),
    rankingObjectives,
    scopeKind,
    hardConstraints: [],
    softPreferences: [],
    diversityGoals: canonicalDiversityGoals(input.contract),
    orderingPolicy: canonicalOrderingPolicy(input.contract),
    softGoalRelaxationOrder: [],
    sourceDiscoveryHints: [],
    conceptDiscoveryHints: canonicalConceptDiscoveryHints(input.contract),
    playlistQuotaRules: input.quotaRules.map((rule) => ({ ...rule, values: [...rule.values] })),
    ...(input.qualityPolicy ? {
      playlistQualityPolicy: {
        ...input.qualityPolicy,
        clauseIds: [...input.qualityPolicy.clauseIds],
        criteria: [...input.qualityPolicy.criteria],
      },
    } : {}),
    canonicalContractPolicy: structuredClone(input.policy),
    ...(input.contract.executionDirectives ? {
      executionDirectives: structuredClone(input.contract.executionDirectives),
    } : {}),
    criticalAmbiguities: [],
    recordingPolicy: canonicalRecordingPolicy(),
    semanticPolicyVersion: SEMANTIC_SCOPE_POLICY_VERSION,
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
    semanticClauses,
    contextSignals: [],
    catalogPolicies,
    explicitUserConstraintHash: input.contract.semanticHash,
    semanticAudit: {
      version: SEMANTIC_PLAN_V3_1_VERSION,
      musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
      passed: true,
      hardConstraintHash,
      aliasCollapses: [],
      contradictions: [],
    },
    confirmed: true,
    resolvedAmbiguityKeys: [],
  } satisfies SelectionPlanV3);
}

function canonicalCompatibilityPlanV2(
  contract: PlaylistContractRevisionV1,
): SelectionPlan {
  const referenced = new Set(predicateClauseIds(contract.trackPredicate, new Set()));
  const selectionAxis = (clause: PlaylistContractClauseV1): SelectionConstraintAxis | null => {
    const axis = clause.kind === "factual_relationship" || clause.axis === "factual_relationship"
      ? "relationship"
      : clause.axis;
    return [
      "genre", "scene", "subgenre", "era", "geography", "language",
      "mood", "activity", "theme", "artist", "album", "track", "label",
      "venue", "recording_version", "content", "evidence", "relationship",
    ].includes(axis)
      ? axis as SelectionConstraintAxis
      : null;
  };
  const constraints = contract.clauses.flatMap((clause): SelectionConstraint[] => {
    const axis = selectionAxis(clause);
    const values = executionValues(clause);
    if (!axis
      || values.length === 0
      || ["storefront_availability", "recording_version", "content"].includes(clause.axis)) {
      return [];
    }
    const hard = referenced.has(clause.id) && clause.hardness === "hard";
    if (!hard && clause.kind !== "ranking_preference") return [];
    return [{
      id: clause.id,
      axis,
      operator: hard
        ? clause.kind === "exclusion" || clause.operator === "exclude"
          ? "exclude"
          : "require"
        : "prefer",
      values,
      kind: hard ? "hard" : "soft",
      geographyRelationship: axis === "geography"
        ? geographyRelationshipFor(clause.values)
        : null,
      relaxationRank: hard ? null : 1,
    }];
  });
  const engines = canonicalEngines(contract, canonicalMembershipPredicates(contract));
  const intents = canonicalExecutionIntents(
    engines,
    canonicalRankingObjectives(contract, null),
  ) as ResearchIntent[];
  const archetypeFor: Partial<Record<ResearchIntent, ResearchArchetype>> = {
    genre_scene: "genre_scene",
    similarity: "similarity",
    mood_activity: "mood_theme_activity",
    theme: "mood_theme_activity",
    artist_catalogue: "artist_catalog",
    editorial_ranking: "editorial_ranked",
    factual_relationship: "factual_relationship",
    exhaustive: "exhaustive",
  };
  const archetypes = unique(intents.flatMap((intent) => {
    const value = archetypeFor[intent];
    return value ? [value] : [];
  })) as ResearchArchetype[];
  const diversityGoals = canonicalDiversityGoals(contract);
  const orderingPolicy = canonicalOrderingPolicy(contract);
  const geographyConstraints: SelectionGeographyConstraint[] = constraints
    .filter(({ axis }) => axis === "geography")
    .flatMap((constraint) => constraint.values.map((value) => ({
      value,
      relationship: constraint.geographyRelationship ?? "unspecified",
    })));
  const valuesFor = (axis: SelectionConstraintAxis) => unique(
    constraints.filter((constraint) => constraint.axis === axis)
      .flatMap(({ values }) => values),
  );
  return {
    schemaVersion: 1,
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07_r2",
    intents,
    scopeKind: canonicalScopeKind(contract, engines),
    ...(contract.executionDirectives?.fixedContainer ? {
      fixedContainerIdentity: {
        kind: contract.executionDirectives.fixedContainer.kind,
        name: contract.executionDirectives.fixedContainer.name,
        artistName: contract.executionDirectives.fixedContainer.artistName,
      },
    } : {}),
    ...(contract.executionDirectives?.fixedTrackList ? {
      fixedTrackList: contract.executionDirectives.fixedTrackList.tracks.map(
        ({ artist, title }) => ({ artist, title }),
      ),
    } : {}),
    archetypes,
    storefront: contract.storefront,
    requestedTrackCount: contract.requestedTrackCount,
    minimumQualifiedTrackCount: contract.requestedTrackCount,
    reserveTrackCount: Math.max(10, Math.ceil(contract.requestedTrackCount * 0.2)),
    constraints,
    geographyConstraints,
    similarityDimensions: valuesFor("relationship"),
    labels: valuesFor("label"),
    venues: valuesFor("venue"),
    referenceRecordings: contract.executionDirectives?.similarity
      ? [...contract.executionDirectives.similarity.seedArtists]
      : valuesFor("track"),
    softGoalRelaxationOrder: [],
    diversityGoals,
    evidencePolicy: contract.versions.evidencePolicy,
    versionPolicy: {
      preferred: [],
      allowed: [
        "canonical", "remaster", "radio_edit", "extended", "remix", "live",
        "acoustic", "clean", "explicit", "instrumental", "karaoke", "cover",
        "alternate", "unknown",
      ],
      excludeCompilations: false,
      excludeKaraokeAndTributes: false,
    },
    orderingPolicy,
    contentPolicy: {
      explicitContent: "allow",
      instrumental: "allow",
      languages: [],
    },
    legacyConstraintAxes: {
      genres: valuesFor("genre"),
      scenes: valuesFor("scene"),
      subgenres: valuesFor("subgenre"),
      eras: [],
      geographies: geographyConstraints,
      languages: valuesFor("language"),
      moods: valuesFor("mood"),
      themes: valuesFor("theme"),
      activities: valuesFor("activity"),
      seedArtists: valuesFor("artist"),
      seedTracks: valuesFor("track"),
      hardIncludes: constraints.filter(({ kind, operator }) => (
        kind === "hard" && operator !== "exclude"
      )).flatMap(({ values }) => values),
      hardExcludes: constraints.filter(({ operator }) => operator === "exclude")
        .flatMap(({ values }) => values),
    },
  };
}

export interface PlaylistContractExecutionProjectionV1 {
  readonly plan: SelectionPlan;
  readonly selectionPlanV3: SelectionPlanV3;
  readonly canonicalContractPolicy: CanonicalPlaylistContractExecutionPolicyV1;
  readonly playlistQuotaRules: readonly CanonicalPlaylistQuotaRule[];
  readonly playlistQualityPolicy: CanonicalPlaylistQualityPolicy | null;
  readonly backend: string;
  readonly backendCapabilityVersion: typeof PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION;
  readonly backendCapabilityHash: string;
  readonly projectionHash: string;
}

export type PlaylistContractExecutionFenceV1 = Pick<
  SelectionPlan,
  "requestedTrackCount" | "minimumQualifiedTrackCount" | "storefront"
>;

/**
 * Compile the active immutable contract into both compatibility and V3
 * execution shapes. The legacy base plan is checked only as a stale-count /
 * storefront fence; none of its semantic fields can affect either output.
 */
export function projectPlaylistContractExecutionV1(input: {
  contract: PlaylistContractRevisionV1;
  basePlan: PlaylistContractExecutionFenceV1;
  /** Test/future failover hook. Production defaults to the v10 V3 declaration. */
  backendCapability?: BackendCapabilityDeclaration;
}): PlaylistContractExecutionProjectionV1 {
  assertPlaylistContractIntegrityV1(input.contract);
  const negotiation = assertPlaylistContractBackendSupportedV1({
    contract: input.contract,
    backend: input.backendCapability,
  });
  if (input.contract.requestedTrackCount !== input.basePlan.requestedTrackCount
    || input.contract.requestedTrackCount !== input.basePlan.minimumQualifiedTrackCount) {
    throw new Error("contract_execution_count_mismatch");
  }
  if (input.contract.storefront !== input.basePlan.storefront) {
    throw new Error("contract_execution_storefront_mismatch");
  }
  const rules = quotaRules(input.contract);
  const qualityPolicy = centralQualityPolicy(input.contract);
  const canonicalContractPolicy = canonicalContractExecutionPolicyV1(input.contract);
  const selectionPlanV3 = canonicalSelectionPlanV3({
    contract: input.contract,
    policy: canonicalContractPolicy,
    quotaRules: rules,
    qualityPolicy,
  });
  const plan = canonicalCompatibilityPlanV2(input.contract);
  const projectionHash = sha256Hex(stableStringify({
    bridgeVersion: PLAYLIST_CONTRACT_EXECUTION_BRIDGE_VERSION,
    contractRevisionId: input.contract.revisionId,
    contractSemanticHash: input.contract.semanticHash,
    playlistQuotaRules: rules,
    playlistQualityPolicy: qualityPolicy,
    canonicalContractPolicy,
    selectionPlanV3,
    backend: negotiation.backend!.backend,
    backendCapabilityVersion: PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION,
    backendCapabilityHash: negotiation.capabilityHash,
  }));
  return {
    plan,
    selectionPlanV3,
    canonicalContractPolicy,
    playlistQuotaRules: rules,
    playlistQualityPolicy: qualityPolicy,
    backend: negotiation.backend!.backend,
    backendCapabilityVersion: PLAYLIST_CONTRACT_BACKEND_CAPABILITY_VERSION,
    backendCapabilityHash: negotiation.capabilityHash!,
    projectionHash,
  };
}
