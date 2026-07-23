import { createHash } from "node:crypto";
import type {
  PipelineV3SourceDiscoveryHint,
  QueryPlanV3,
  QueryPlanV3Engine,
  QueryPlanV3SemanticClause,
  SelectionConstraint,
} from "../shared/types.ts";
import {
  EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
} from "../shared/product-policy.ts";
import {
  PIPELINE_V3_MAX_SOURCE_DISCOVERY_HINTS,
  selectionPlanV3Hash,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "./music-concepts-v3.ts";
import { assertPublicHttpsUrl, stableStringify } from "./security.ts";
import { assertCanonicalContractExecutionPolicyV1 } from "./canonical-contract-runtime-v1.ts";
import {
  PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION,
} from "./playlist-contract-v1.ts";
import {
  EVIDENCE_POLICY_VERSION,
  GUIDANCE_POLICY_VERSION,
} from "./guidance-contract-v2.ts";
import { canonicalContractActivationConfigured } from "./release-deployment-phase.ts";

export const LEGACY_QUERY_PLAN_V3_VERSION = 1 as const;
export const LEGACY_QUERY_PLAN_V3_POLICY_VERSION = "corpus_first_v3_policy_v1" as const;
export const QUERY_PLAN_V3_VERSION = 2 as const;
export const CONTRACT_QUERY_PLAN_V3_VERSION = 3 as const;
export const CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION = 4 as const;
// Schema 2 refines the query contract; it does not create a new persisted run
// policy. Both schemas drain under the frozen V3 policy-v1 contract.
export const QUERY_PLAN_V3_POLICY_VERSION = "corpus_first_v3_policy_v1" as const;

export type QueryPlanV3SchemaVersion =
  | typeof LEGACY_QUERY_PLAN_V3_VERSION
  | typeof QUERY_PLAN_V3_VERSION
  | typeof CONTRACT_QUERY_PLAN_V3_VERSION
  | typeof CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION;

export function queryPlanV3EmissionSchemaVersion(
  env: NodeJS.ProcessEnv = process.env,
): QueryPlanV3SchemaVersion {
  if (
    env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION === "4"
    && canonicalContractActivationConfigured(env)
  ) {
    return CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION;
  }
  if (env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION === "3") return CONTRACT_QUERY_PLAN_V3_VERSION;
  if (env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION === "2") return QUERY_PLAN_V3_VERSION;
  return LEGACY_QUERY_PLAN_V3_VERSION;
}

export type PipelineV3RolloutGroup =
  | "genre_scene"
  | "mood_activity_theme"
  | "similarity"
  | "artist_catalogue"
  | "fixed_container"
  | "factual_relationship"
  | "exhaustive";

export interface PipelineV3Assignment {
  assigned: boolean;
  cohort: number;
  percentage: number;
  group: PipelineV3RolloutGroup;
  reason:
    | "master_disabled"
    | "guidance_required"
    | "owner_canary"
    | "production_evidence_required"
    | "governed_curated_hosted_evidence_required"
    | "governed_geographic_evidence_required"
    | "factual_feasibility_required"
    | "sticky_rollout"
    | "control";
}

function boundedPercentage(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

function rolloutCohort(stickyKey: string): number {
  return createHash("sha256").update(stickyKey).digest().readUInt32BE(0) % 10_000;
}

function isFixedContainerPrompt(prompt: string): boolean {
  const normalized = prompt.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  return /\b(?:this|the|from|every|all)\s+(?:album|soundtrack|compilation|chart|label catalogue|label catalog|track list|playlist)\b/u.test(normalized)
    || /\b(?:album|soundtrack|compilation)\s+["“][^"”]{2,120}["”]/u.test(normalized);
}

export function queryPlanV3Engines(plan: SelectionPlanV3): QueryPlanV3Engine[] {
  const engines: QueryPlanV3Engine[] = [];
  if (plan.intents.includes("exhaustive")) engines.push("exhaustive");
  else if (plan.intents.includes("factual_relationship")) engines.push("factual_relationship");
  if (isFixedContainerPrompt(plan.prompt)) engines.push("fixed_container");
  if (plan.intents.includes("artist_catalogue")) engines.push("artist_catalogue");
  if (plan.intents.includes("similarity")) engines.push("similarity");
  if (plan.intents.includes("mood_activity") || plan.intents.includes("theme")) {
    engines.push("mood_activity_theme");
  }
  if (plan.intents.includes("genre_scene") || plan.intents.includes("editorial_ranking") || engines.length === 0) {
    engines.push("curated_genre_scene");
  }
  return [...new Set(engines)];
}

export function primaryQueryPlanV3Engine(plan: SelectionPlanV3): QueryPlanV3Engine {
  return queryPlanV3Engines(plan)[0]!;
}

export function pipelineV3RolloutGroup(plan: SelectionPlanV3): PipelineV3RolloutGroup {
  const engine = primaryQueryPlanV3Engine(plan);
  return engine === "curated_genre_scene" ? "genre_scene" : engine;
}

function rolloutVariable(group: PipelineV3RolloutGroup): string {
  switch (group) {
    case "genre_scene": return "PIPELINE_V3_GENRE_SCENE_PERCENT";
    case "mood_activity_theme": return "PIPELINE_V3_MOOD_ACTIVITY_PERCENT";
    case "similarity": return "PIPELINE_V3_SIMILARITY_PERCENT";
    case "artist_catalogue": return "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT";
    case "fixed_container": return "PIPELINE_V3_FIXED_CONTAINER_PERCENT";
    case "factual_relationship": return "PIPELINE_V3_FACTUAL_PERCENT";
    case "exhaustive": return "PIPELINE_V3_EXHAUSTIVE_PERCENT";
  }
}

function ownerCanaryAllows(
  plan: SelectionPlanV3,
  group: PipelineV3RolloutGroup,
  env: NodeJS.ProcessEnv,
): boolean {
  if (env.PIPELINE_V3_OWNER_CANARY !== "true") return false;
  const groups = new Set(
    (env.PIPELINE_V3_OWNER_CANARY_GROUPS ?? "genre_scene")
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is PipelineV3RolloutGroup => (
        value === "genre_scene"
        || value === "mood_activity_theme"
        || value === "similarity"
        || value === "artist_catalogue"
        || value === "fixed_container"
        || value === "factual_relationship"
        || value === "exhaustive"
      )),
  );
  const configuredMaximum = Number(env.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS ?? 50);
  const maximumTracks = Number.isSafeInteger(configuredMaximum)
    ? Math.max(1, Math.min(EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS, configuredMaximum))
    : 50;
  return groups.has(group) && plan.requestedTrackCount <= maximumTracks;
}

/** Master-off and unresolved-guidance checks happen before cohort assignment. */
export function assignPipelineV3(input: {
  plan: SelectionPlanV3;
  owner: boolean;
  stickyKey: string;
  env?: NodeJS.ProcessEnv;
}): PipelineV3Assignment {
  const env = input.env ?? process.env;
  const group = pipelineV3RolloutGroup(input.plan);
  const cohort = rolloutCohort(`${input.stickyKey}:${group}:${QUERY_PLAN_V3_POLICY_VERSION}`);
  if (env.PIPELINE_V3_ASSIGNMENT_ENABLED !== "true") {
    return { assigned: false, cohort, percentage: 0, group, reason: "master_disabled" };
  }
  if (!input.plan.confirmed || input.plan.criticalAmbiguities.some(({ key }) => !input.plan.resolvedAmbiguityKeys.includes(key))) {
    return { assigned: false, cohort, percentage: 0, group, reason: "guidance_required" };
  }
  const requiresGeographicEvidence = input.plan.membershipPredicates.some((predicate) => (
    predicate.operator !== "exclude"
    && predicate.geographyRelationship !== null
    && predicate.geographyRelationship !== undefined
    && predicate.geographyRelationship !== "sound_association"
  ));
  const requiresCuratedHostedEvidence = (
    group === "genre_scene"
    || group === "mood_activity_theme"
    || group === "similarity"
  ) && env.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED !== "true";
  if (input.owner && requiresCuratedHostedEvidence) {
    return {
      assigned: false,
      cohort,
      percentage: 0,
      group,
      reason: "governed_curated_hosted_evidence_required",
    };
  }
  if (input.owner
    && requiresGeographicEvidence
    && env.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED !== "true") {
    return {
      assigned: false,
      cohort,
      percentage: 0,
      group,
      reason: "governed_geographic_evidence_required",
    };
  }
  if (input.owner && ownerCanaryAllows(input.plan, group, env)) {
    return { assigned: true, cohort, percentage: 100, group, reason: "owner_canary" };
  }
  if (env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED !== "true") {
    return { assigned: false, cohort, percentage: 0, group, reason: "production_evidence_required" };
  }
  if (requiresCuratedHostedEvidence) {
    return {
      assigned: false,
      cohort,
      percentage: 0,
      group,
      reason: "governed_curated_hosted_evidence_required",
    };
  }
  if (requiresGeographicEvidence
    && env.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED !== "true") {
    return {
      assigned: false,
      cohort,
      percentage: 0,
      group,
      reason: "governed_geographic_evidence_required",
    };
  }
  if ((group === "factual_relationship" || group === "exhaustive")
    && env.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED !== "true") {
    return { assigned: false, cohort, percentage: 0, group, reason: "factual_feasibility_required" };
  }
  const percentage = boundedPercentage(env[rolloutVariable(group)]);
  const assigned = cohort < Math.round(percentage * 100);
  return { assigned, cohort, percentage, group, reason: assigned ? "sticky_rollout" : "control" };
}

function constraintKey(value: SelectionConstraint): string {
  return `${value.axis}:${value.operator}:${value.kind}:${value.values.join("|")}:${value.geographyRelationship ?? ""}`;
}

function semanticClause(value: SelectionPlanV3["semanticClauses"][number]): QueryPlanV3SemanticClause {
  return {
    id: value.id,
    role: value.role,
    axis: value.axis,
    operator: value.operator,
    values: [...value.values],
    source: value.source,
    explicitUserAuthored: value.explicitUserAuthored,
    geographyRelationship: value.geographyRelationship ?? null,
    reason: value.reason,
  };
}

function normalizedValues(values: readonly string[]): string[] {
  return values.map((value) => value.normalize("NFKC").trim().toLowerCase()).sort();
}

function normalizedSemanticAxis(axis: string): string {
  return axis === "factual_relationship" ? "relationship" : axis;
}

function operatorsProjectSameMembership(
  clauseOperator: QueryPlanV3SemanticClause["operator"],
  constraintOperator: SelectionConstraint["operator"],
): boolean {
  if (clauseOperator === "exclude" || constraintOperator === "exclude" || constraintOperator === "avoid") {
    return clauseOperator === "exclude"
      && (constraintOperator === "exclude" || constraintOperator === "avoid");
  }
  return (clauseOperator === "include" || clauseOperator === "require")
    && (constraintOperator === "include" || constraintOperator === "require");
}

function membershipClauseDuplicatesConstraint(
  constraint: SelectionConstraint,
  clauses: readonly QueryPlanV3SemanticClause[],
): boolean {
  if (constraint.kind !== "hard" || constraint.operator === "maximum") return false;
  return clauses.some((clause) => (
    clause.role === "membership"
    && normalizedSemanticAxis(clause.axis) === constraint.axis
    && operatorsProjectSameMembership(clause.operator, constraint.operator)
    && stableStringify(normalizedValues(clause.values)) === stableStringify(normalizedValues(constraint.values))
    && (clause.geographyRelationship ?? null) === (constraint.geographyRelationship ?? null)
  ));
}

/**
 * Schema 2 executes semantic membership and catalog policy from their typed
 * clauses. The legacy hard-constraint bag is retained solely for the two
 * aggregate quotas the selector still consumes. Any other entry would be an
 * unbound second execution path and must be dropped at compile time and
 * rejected at decode time.
 */
function schemaTwoExecutableHardConstraint(constraint: SelectionConstraint): boolean {
  return constraint.kind === "hard"
    && constraint.operator === "maximum"
    && (constraint.axis === "artist" || constraint.axis === "album")
    && constraint.values.length === 1
    && Number.isSafeInteger(Number(constraint.values[0]))
    && Number(constraint.values[0]) >= 1;
}

function distinctConstraints(values: readonly SelectionConstraint[]): SelectionConstraint[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const key = constraintKey(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      ...value,
      values: [...value.values],
      geographyRelationship: value.geographyRelationship ?? null,
    }];
  });
}

export function createQueryPlanV3(
  plan: SelectionPlanV3,
  graphSnapshotId: string,
  options: {
    readonly schemaVersion?: QueryPlanV3SchemaVersion;
    readonly briefContractVersion?: 1 | 2 | 3;
    readonly executionDeltaHash?: string;
    readonly playlistContractRevisionId?: string;
    readonly playlistContractSemanticHash?: string;
    readonly playlistContractCompilerVersion?: string;
  } = {},
): QueryPlanV3 {
  const requestedSchemaVersion = options.schemaVersion ?? QUERY_PLAN_V3_VERSION;
  if (
    plan.requestedTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
    && requestedSchemaVersion !== CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
  ) {
    throw new Error(
      "Expanded query plans require schema 4 and a fenced canonical contract revision",
    );
  }
  if (requestedSchemaVersion >= QUERY_PLAN_V3_VERSION
    && plan.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION) {
    throw new Error("Typed query plans require the current governed music-concept policy");
  }
  if (requestedSchemaVersion === CONTRACT_QUERY_PLAN_V3_VERSION
    && (options.briefContractVersion !== 2
      || typeof options.executionDeltaHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(options.executionDeltaHash))) {
    throw new Error("Schema-3 query plans require a contract-2 execution-delta hash");
  }
  if (requestedSchemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
    && (options.briefContractVersion !== 3
      || typeof options.playlistContractRevisionId !== "string"
      || !options.playlistContractRevisionId.startsWith("pcr1:")
      || typeof options.playlistContractSemanticHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(options.playlistContractSemanticHash)
      || typeof options.playlistContractCompilerVersion !== "string"
      || options.playlistContractCompilerVersion.length < 1)) {
    throw new Error("Schema-4 query plans require a fenced canonical contract revision");
  }
  if (requestedSchemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION) {
    if (!plan.canonicalContractPolicy) {
      throw new Error("Schema-4 query plans require the canonical runtime selection policy");
    }
    assertCanonicalContractExecutionPolicyV1(plan.canonicalContractPolicy);
    if (plan.canonicalContractPolicy.contractRevisionId !== options.playlistContractRevisionId
      || plan.canonicalContractPolicy.contractSemanticHash !== options.playlistContractSemanticHash
      || plan.canonicalContractPolicy.contractCompilerVersion
        !== options.playlistContractCompilerVersion
      || plan.canonicalContractPolicy.requestedTrackCount !== plan.requestedTrackCount
      || plan.canonicalContractPolicy.storefront !== plan.storefront) {
      throw new Error("Schema-4 canonical runtime policy does not match its contract fence");
    }
  }
  if (!plan.confirmed || plan.criticalAmbiguities.some(({ key }) => !plan.resolvedAmbiguityKeys.includes(key))) {
    throw new Error("Critical playlist ambiguity must be resolved before a V3 query plan is created");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(graphSnapshotId)) {
    throw new Error("A locked graph snapshot id is required");
  }
  const engines = queryPlanV3Engines(plan);
  const semanticClauses = plan.semanticClauses.map(semanticClause);
  const contextSignals = plan.contextSignals.map(semanticClause);
  const catalogPolicies = plan.catalogPolicies.map(semanticClause);
  const hardConstraintHash = plan.semanticAudit?.hardConstraintHash
    ?? createHash("sha256").update(stableStringify(semanticClauses
      .filter((clause) => clause.role === "membership")
      .map(({ axis, operator, values }) => ({ axis, operator, values: normalizedValues(values) }))
    )).digest("hex");
  const schemaTwo: QueryPlanV3 = {
    schemaVersion: requestedSchemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
      ? CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
      : requestedSchemaVersion === CONTRACT_QUERY_PLAN_V3_VERSION
        ? CONTRACT_QUERY_PLAN_V3_VERSION
        : QUERY_PLAN_V3_VERSION,
    pipelineVersion: "corpus_first_v3",
    policyVersion: QUERY_PLAN_V3_POLICY_VERSION,
    engine: engines[0]!,
    engines,
    selectionPlanHash: selectionPlanV3Hash(plan),
    graphSnapshotId,
    membershipPredicates: plan.membershipPredicates.map((predicate) => ({
      id: predicate.id,
      kind: predicate.axis,
      subject: predicate.values.join(" | "),
      relationship: predicate.operator,
      hard: true,
    })),
    rankingObjectives: plan.rankingObjectives.map((objective) => ({
      id: objective.id,
      kind: objective.dimension,
      description: objective.reason,
      weight: objective.weight,
      values: [...objective.values],
    })),
    targetTrackCount: plan.requestedTrackCount,
    storefront: plan.storefront,
    // Membership is authoritative in semanticClauses. Keeping the same rule
    // in hardConstraints would execute it twice and previously turned
    // listener context into an accidental evidence gate.
    hardConstraints: distinctConstraints(plan.hardConstraints)
      .filter((constraint) => !membershipClauseDuplicatesConstraint(constraint, semanticClauses))
      .filter(schemaTwoExecutableHardConstraint),
    softPreferences: distinctConstraints(plan.softPreferences),
    sourceDiscoveryHints: plan.sourceDiscoveryHints.map((hint) => ({ ...hint })),
    scopeKind: plan.scopeKind,
    diversityGoals: { ...plan.diversityGoals },
    orderingPolicy: { ...plan.orderingPolicy, goals: [...plan.orderingPolicy.goals] },
    softGoalRelaxationOrder: [...plan.softGoalRelaxationOrder],
    semanticPolicyVersion: plan.semanticPolicyVersion,
    musicConceptPolicyVersion: plan.musicConceptPolicyVersion,
    semanticClauses,
    contextSignals,
    catalogPolicies,
    recordingPolicy: {
      allowedVersions: [...plan.recordingPolicy.allowedVersions],
      preferCanonicalStudio: plan.recordingPolicy.preferCanonicalStudio,
      excludeKaraokeTributeAndCovers: plan.recordingPolicy.excludeKaraokeTributeAndCovers,
    },
    explicitUserConstraintHash: plan.explicitUserConstraintHash,
    hardConstraintHash,
    semanticAuditMetadata: {
      semanticPolicyVersion: plan.semanticPolicyVersion,
      musicConceptPolicyVersion: plan.musicConceptPolicyVersion,
      passed: plan.semanticAudit?.passed ?? true,
      hardConstraintHash,
      explicitUserConstraintHash: plan.explicitUserConstraintHash,
      clauseCount: semanticClauses.length,
      membershipClauseCount: semanticClauses.filter((clause) => clause.role === "membership").length,
      contextClauseCount: contextSignals.length,
      catalogPolicyClauseCount: catalogPolicies.length,
      aliasCollapses: [...(plan.semanticAudit?.aliasCollapses ?? [])],
      contradictions: [...(plan.semanticAudit?.contradictions ?? [])],
    },
    ...(requestedSchemaVersion === CONTRACT_QUERY_PLAN_V3_VERSION ? {
      briefContractVersion: 2 as const,
      guidancePolicyVersion: GUIDANCE_POLICY_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      executionDeltaHash: options.executionDeltaHash,
    } : {}),
    ...(requestedSchemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION ? {
      briefContractVersion: 3 as const,
      guidancePolicyVersion: "adaptive_guidance_v3",
      evidencePolicyVersion: PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION,
      playlistContractRevisionId: options.playlistContractRevisionId,
      playlistContractSemanticHash: options.playlistContractSemanticHash,
      playlistContractCompilerVersion: options.playlistContractCompilerVersion,
      playlistQuotaRules: (plan.playlistQuotaRules ?? []).map((rule) => ({
        ...rule,
        values: [...rule.values],
        ...(rule.predicate ? { predicate: structuredClone(rule.predicate) } : {}),
      })),
      ...(plan.playlistQualityPolicy ? {
        playlistQualityPolicy: {
          ...plan.playlistQualityPolicy,
          clauseIds: [...plan.playlistQualityPolicy.clauseIds],
          criteria: [...plan.playlistQualityPolicy.criteria],
        },
      } : {}),
      ...(plan.canonicalContractPolicy ? {
        canonicalContractPolicy: structuredClone(plan.canonicalContractPolicy),
      } : {}),
    } : {}),
  };
  if ((options.schemaVersion ?? QUERY_PLAN_V3_VERSION) !== LEGACY_QUERY_PLAN_V3_VERSION) {
    return Object.freeze(schemaTwo);
  }
  const legacy: QueryPlanV3 = {
    ...schemaTwo,
    schemaVersion: LEGACY_QUERY_PLAN_V3_VERSION,
    policyVersion: LEGACY_QUERY_PLAN_V3_POLICY_VERSION,
    // Schema 1 has no typed semantic-clause execution path, so its confirmed
    // selection-plan constraints remain the sole legacy catalog/constraint
    // projection. Reusing schema 2's deliberately narrow aggregate-only bag
    // makes the persisted query diverge from its immutable selection plan and
    // causes a valid worker result to be fenced as stale. The corrected
    // semantic compiler has already removed contextual and duplicated
    // membership gates from this list before query compilation.
    hardConstraints: distinctConstraints(plan.hardConstraints),
  };
  delete legacy.semanticPolicyVersion;
  delete legacy.musicConceptPolicyVersion;
  delete legacy.semanticClauses;
  delete legacy.contextSignals;
  delete legacy.catalogPolicies;
  delete legacy.recordingPolicy;
  delete legacy.explicitUserConstraintHash;
  delete legacy.hardConstraintHash;
  delete legacy.semanticAuditMetadata;
  return Object.freeze(legacy);
}

/** Runtime compilation stays on schema 1 through the compatibility deploy and
 * switches only when Railway explicitly activates schema 2. */
export function createRuntimeQueryPlanV3(
  plan: SelectionPlanV3,
  graphSnapshotId: string,
  env: NodeJS.ProcessEnv = process.env,
  contract: {
    readonly briefContractVersion?: 1 | 2 | 3;
    readonly executionDeltaHash?: string;
    readonly playlistContractRevisionId?: string;
    readonly playlistContractSemanticHash?: string;
    readonly playlistContractCompilerVersion?: string;
  } = {},
): QueryPlanV3 {
  return createQueryPlanV3(plan, graphSnapshotId, {
    schemaVersion: queryPlanV3EmissionSchemaVersion(env),
    ...contract,
  });
}

export function queryPlanV3Hash(plan: QueryPlanV3): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

const QUERY_PLAN_V3_ROLES = new Set([
  "membership",
  "catalog_policy",
  "context",
  "ranking",
  "diversity_sequencing",
  "discovery_hint",
]);
const QUERY_PLAN_V3_SOURCES = new Set([
  "raw_prompt",
  "guided_answer",
  "v2_compatibility",
  "system_default",
]);
const QUERY_PLAN_V3_GEOGRAPHY_RELATIONSHIPS = new Set([
  "artist_origin",
  "artist_residence",
  "recording_location",
  "label_or_venue_scene",
  "language",
  "sound_association",
  "unspecified",
]);
const QUERY_PLAN_V3_RECORDING_VERSIONS = new Set([
  "canonical",
  "clean",
  "explicit",
  "live",
  "remix",
  "radio_edit",
  "extended",
  "acoustic",
  "instrumental",
]);

function isSemanticClause(value: unknown): value is QueryPlanV3SemanticClause {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const clause = value as Partial<QueryPlanV3SemanticClause>;
  return typeof clause.id === "string"
    && /^[A-Za-z0-9._:-]{1,160}$/u.test(clause.id)
    && typeof clause.role === "string"
    && QUERY_PLAN_V3_ROLES.has(clause.role)
    && typeof clause.axis === "string" && /^[A-Za-z0-9._:-]{1,80}$/u.test(clause.axis)
    && typeof clause.operator === "string" && /^[A-Za-z0-9._:-]{1,80}$/u.test(clause.operator)
    && Array.isArray(clause.values)
    && clause.values.length <= 50
    && clause.values.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)
    && typeof clause.source === "string" && QUERY_PLAN_V3_SOURCES.has(clause.source)
    && typeof clause.explicitUserAuthored === "boolean"
    && (clause.geographyRelationship === null
      || (typeof clause.geographyRelationship === "string"
        && QUERY_PLAN_V3_GEOGRAPHY_RELATIONSHIPS.has(clause.geographyRelationship)))
    && typeof clause.reason === "string" && clause.reason.length > 0 && clause.reason.length <= 500;
}

function sameClause(left: QueryPlanV3SemanticClause, right: QueryPlanV3SemanticClause): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isCanonicalPlaylistQuotaRule(
  value: unknown,
): value is NonNullable<QueryPlanV3["playlistQuotaRules"]>[number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Partial<NonNullable<QueryPlanV3["playlistQuotaRules"]>[number]>;
  const count = (candidate: unknown) => candidate === null
    || (Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= 10_000);
  const ratio = (candidate: unknown) => candidate === null
    || (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1);
  return typeof rule.id === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(rule.id)
    && typeof rule.clauseId === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(rule.clauseId)
    && rule.axis === "genre"
    && Array.isArray(rule.values)
    && rule.values.length > 0
    && rule.values.length <= 20
    && rule.values.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)
    && count(rule.minimumCount)
    && count(rule.maximumCount)
    && ratio(rule.minimumRatio)
    && ratio(rule.maximumRatio)
    && (rule.minimumCount !== null
      || rule.maximumCount !== null
      || rule.minimumRatio !== null
      || rule.maximumRatio !== null)
    && [
      "authoritative_structured_metadata",
      "trusted_scoped_container",
      "track_specific_editorial_assertion",
      "primary_source",
      "independent_secondary_source",
    ].includes(String(rule.evidenceGrade))
    && (rule.predicate === undefined
      || (rule.predicate !== null && typeof rule.predicate === "object"));
}

function isCanonicalPlaylistQualityPolicy(
  value: unknown,
): value is NonNullable<QueryPlanV3["playlistQualityPolicy"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<NonNullable<QueryPlanV3["playlistQualityPolicy"]>>;
  const ratio = (candidate: unknown) => (
    typeof candidate === "number"
    && Number.isFinite(candidate)
    && candidate >= 0
    && candidate <= 1
  );
  return policy.policyVersion === "canonical_central_quality_v1"
    && Array.isArray(policy.clauseIds)
    && policy.clauseIds.length > 0
    && policy.clauseIds.length <= 40
    && policy.clauseIds.every((id) => (
      typeof id === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(id)
    ))
    && Array.isArray(policy.criteria)
    && policy.criteria.length > 0
    && policy.criteria.length <= 40
    && policy.criteria.every((criterion) => (
      typeof criterion === "string" && criterion.trim().length > 0 && criterion.length <= 240
    ))
    && ratio(policy.minimumPassRatio)
    && ratio(policy.maximumUnknownRatio)
    && policy.zeroKnownFailures === true
    && policy.signalDimension === "central_quality"
    && ratio(policy.passThreshold)
    && ratio(policy.failThreshold)
    && Number(policy.failThreshold) < Number(policy.passThreshold)
    && policy.signalSemantics === "ranking_only_not_factual_evidence";
}

function isCanonicalContractRuntimePolicy(
  value: unknown,
  row: Partial<Pick<QueryPlanV3, "playlistContractRevisionId" | "playlistContractSemanticHash" | "targetTrackCount" | "storefront">>,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    assertCanonicalContractExecutionPolicyV1(
      value as NonNullable<QueryPlanV3["canonicalContractPolicy"]>,
    );
  } catch {
    return false;
  }
  const policy = value as NonNullable<QueryPlanV3["canonicalContractPolicy"]>;
  return typeof row.playlistContractRevisionId === "string"
    && typeof row.playlistContractSemanticHash === "string"
    && typeof row.targetTrackCount === "number"
    && typeof row.storefront === "string"
    && policy.contractRevisionId === row.playlistContractRevisionId
    && policy.contractSemanticHash === row.playlistContractSemanticHash
    && policy.requestedTrackCount === row.targetTrackCount
    && policy.storefront === row.storefront;
}

function membershipOperatorPolarity(operator: string): "positive" | "exclude" | null {
  if (operator === "include" || operator === "require") return "positive";
  if (operator === "exclude") return "exclude";
  return null;
}

function isMembershipPredicateProjection(
  value: unknown,
): value is QueryPlanV3["membershipPredicates"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const predicate = value as Partial<QueryPlanV3["membershipPredicates"][number]>;
  return typeof predicate.id === "string"
    && /^[A-Za-z0-9._:-]{1,160}$/u.test(predicate.id)
    && typeof predicate.kind === "string" && /^[A-Za-z0-9._:-]{1,80}$/u.test(predicate.kind)
    && typeof predicate.subject === "string" && predicate.subject.length > 0 && predicate.subject.length <= 12_000
    && typeof predicate.relationship === "string"
    && membershipOperatorPolarity(predicate.relationship) !== null
    && typeof predicate.hard === "boolean";
}

function membershipProjectionMatches(
  clauses: readonly QueryPlanV3SemanticClause[],
  predicates: readonly unknown[],
): boolean {
  const membershipClauses = clauses.filter((clause) => clause.role === "membership");
  if (!predicates.every(isMembershipPredicateProjection)
    || predicates.length !== membershipClauses.length
    || new Set(predicates.map((predicate) => predicate.id)).size !== predicates.length) return false;
  const predicateById = new Map(predicates.map((predicate) => [predicate.id, predicate]));
  return membershipClauses.every((clause) => {
    const predicate = predicateById.get(clause.id);
    const clausePolarity = membershipOperatorPolarity(clause.operator);
    const predicatePolarity = predicate
      ? membershipOperatorPolarity(predicate.relationship)
      : null;
    return predicate !== undefined
      && predicate.hard === true
      && normalizedSemanticAxis(predicate.kind) === normalizedSemanticAxis(clause.axis)
      && clausePolarity !== null
      && clausePolarity === predicatePolarity
      // The schema-1 compatibility projection has no values array. Its
      // subject is therefore an integrity field, not presentation prose.
      && predicate.subject === clause.values.join(" | ");
  });
}

function semanticRoleProjectionMatches(
  clauses: readonly QueryPlanV3SemanticClause[],
  projection: readonly QueryPlanV3SemanticClause[],
  role: "context" | "catalog_policy",
): boolean {
  const expected = clauses.filter((clause) => clause.role === role);
  if (projection.length !== expected.length
    || new Set(projection.map((clause) => clause.id)).size !== projection.length) return false;
  const expectedById = new Map(expected.map((clause) => [clause.id, clause]));
  return projection.every((clause) => (
    clause.role === role
    && expectedById.has(clause.id)
    && sameClause(clause, expectedById.get(clause.id)!)
  ));
}

function typedQueryPlanContractValid(row: Partial<QueryPlanV3>): boolean {
  if ((row.schemaVersion !== QUERY_PLAN_V3_VERSION
      && row.schemaVersion !== CONTRACT_QUERY_PLAN_V3_VERSION
      && row.schemaVersion !== CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION)
    || row.policyVersion !== QUERY_PLAN_V3_POLICY_VERSION
    || row.semanticPolicyVersion !== "scope_gate_v2_1_2"
    || row.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION
    || !Array.isArray(row.semanticClauses)
    || row.semanticClauses.length < 1 || row.semanticClauses.length > 500
    || !row.semanticClauses.every(isSemanticClause)
    || new Set(row.semanticClauses.map((clause) => clause.id)).size !== row.semanticClauses.length
    || !Array.isArray(row.contextSignals) || !row.contextSignals.every(isSemanticClause)
    || !Array.isArray(row.catalogPolicies) || !row.catalogPolicies.every(isSemanticClause)
    || typeof row.explicitUserConstraintHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.explicitUserConstraintHash)
    || typeof row.hardConstraintHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.hardConstraintHash)
    || !row.recordingPolicy || typeof row.recordingPolicy !== "object"
    || !Array.isArray(row.recordingPolicy.allowedVersions)
    || row.recordingPolicy.allowedVersions.length < 1
    || row.recordingPolicy.allowedVersions.some((version) => !QUERY_PLAN_V3_RECORDING_VERSIONS.has(version))
    || typeof row.recordingPolicy.preferCanonicalStudio !== "boolean"
    || typeof row.recordingPolicy.excludeKaraokeTributeAndCovers !== "boolean"
    || !row.semanticAuditMetadata || typeof row.semanticAuditMetadata !== "object") return false;
  const clauses = row.semanticClauses as QueryPlanV3SemanticClause[];
  const signals = row.contextSignals as QueryPlanV3SemanticClause[];
  const policies = row.catalogPolicies as QueryPlanV3SemanticClause[];
  if (clauses.some((clause) => (
    (clause.role === "membership" || clause.role === "context" || clause.role === "catalog_policy")
    && clause.values.length === 0
  ))) return false;
  if (!Array.isArray(row.membershipPredicates)
    || !membershipProjectionMatches(clauses, row.membershipPredicates)
    || !semanticRoleProjectionMatches(clauses, signals, "context")
    || !semanticRoleProjectionMatches(clauses, policies, "catalog_policy")) return false;
  const membershipClauseCount = clauses.filter((clause) => clause.role === "membership").length;
  const contextClauseCount = clauses.filter((clause) => clause.role === "context").length;
  const catalogPolicyClauseCount = clauses.filter((clause) => clause.role === "catalog_policy").length;
  const audit = row.semanticAuditMetadata;
  if (audit.semanticPolicyVersion !== row.semanticPolicyVersion
    || audit.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION
    || audit.musicConceptPolicyVersion !== row.musicConceptPolicyVersion
    || audit.passed !== true
    || audit.hardConstraintHash !== row.hardConstraintHash
    || audit.explicitUserConstraintHash !== row.explicitUserConstraintHash
    || audit.clauseCount !== clauses.length
    || audit.membershipClauseCount !== membershipClauseCount
    || audit.contextClauseCount !== contextClauseCount
    || audit.catalogPolicyClauseCount !== catalogPolicyClauseCount
    || !Array.isArray(audit.aliasCollapses) || !audit.aliasCollapses.every((item) => typeof item === "string" && item.length <= 240)
    || !Array.isArray(audit.contradictions) || audit.contradictions.length !== 0) return false;
  // Schema 2 must not execute one membership rule twice through the legacy
  // hard-constraint bag.
  if ((row.hardConstraints ?? []).some((constraint) => membershipClauseDuplicatesConstraint(constraint, clauses))) {
    return false;
  }
  if ((row.hardConstraints ?? []).some((constraint) => !schemaTwoExecutableHardConstraint(constraint))) {
    return false;
  }
  if (row.schemaVersion === CONTRACT_QUERY_PLAN_V3_VERSION && (
    row.briefContractVersion !== 2
    || row.guidancePolicyVersion !== GUIDANCE_POLICY_VERSION
    || row.evidencePolicyVersion !== EVIDENCE_POLICY_VERSION
    || typeof row.executionDeltaHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.executionDeltaHash)
  )) return false;
  if (row.schemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION && (
    row.briefContractVersion !== 3
    || row.guidancePolicyVersion !== "adaptive_guidance_v3"
    || row.evidencePolicyVersion !== PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION
    || typeof row.playlistContractRevisionId !== "string"
    || !row.playlistContractRevisionId.startsWith("pcr1:")
    || typeof row.playlistContractSemanticHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.playlistContractSemanticHash)
    || typeof row.playlistContractCompilerVersion !== "string"
    || row.playlistContractCompilerVersion.length < 1
    || !Array.isArray(row.playlistQuotaRules)
    || row.playlistQuotaRules.length > 20
    || !row.playlistQuotaRules.every(isCanonicalPlaylistQuotaRule)
    || (row.playlistQualityPolicy !== undefined
      && !isCanonicalPlaylistQualityPolicy(row.playlistQualityPolicy))
    || !isCanonicalContractRuntimePolicy(row.canonicalContractPolicy, row)
  )) return false;
  return true;
}

export function isQueryPlanV3(value: unknown): value is QueryPlanV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<QueryPlanV3>;
  const continuation = row.continuation;
  const continuationValid = continuation === undefined || (
    continuation !== null
    && typeof continuation === "object"
    && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(continuation.sourceQueryPlanRevisionId)
    && /^[a-f0-9]{64}$/u.test(continuation.sourceQueryPlanHash)
    && continuation.sourceStageKey.length > 0
    && continuation.sourceStageKey.length <= 160
    && /^[a-f0-9]{64}$/u.test(continuation.sourceOutcomeHash)
    && Number.isSafeInteger(continuation.sourceOutcomeVersion)
    && continuation.sourceOutcomeVersion >= 1
    && Array.isArray(continuation.strategyIds)
    && continuation.strategyIds.length > 0
    && continuation.strategyIds.length <= 100
    && new Set(continuation.strategyIds).size === continuation.strategyIds.length
    && continuation.strategyIds.every((id) => (
      typeof id === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(id)
    ))
  );
  const corpusReview = row.corpusReview;
  const corpusReviewValid = corpusReview === undefined || (
    corpusReview !== null
    && typeof corpusReview === "object"
    && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(corpusReview.sourceQueryPlanRevisionId)
    && /^[a-f0-9]{64}$/u.test(corpusReview.sourceQueryPlanHash)
    && corpusReview.sourceStageKey.length > 0
    && corpusReview.sourceStageKey.length <= 160
    && /^[a-f0-9]{64}$/u.test(corpusReview.sourceCheckpointHash)
    && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(corpusReview.reviewedGraphSnapshotId)
    && corpusReview.reviewedGraphSnapshotId === row.graphSnapshotId
    && typeof corpusReview.enumerationComplete === "boolean"
    && Number.isFinite(Date.parse(corpusReview.reviewedAt))
  );
  const sourceDiscoveryHintsValid = Array.isArray(row.sourceDiscoveryHints)
    && row.sourceDiscoveryHints.length <= PIPELINE_V3_MAX_SOURCE_DISCOVERY_HINTS
    && row.sourceDiscoveryHints.every((value): value is PipelineV3SourceDiscoveryHint => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const hint = value as Partial<PipelineV3SourceDiscoveryHint>;
      if (hint.attestation !== "guidance_scout_provider_response"
        || typeof hint.url !== "string"
        || typeof hint.title !== "string"
        || typeof hint.excerpt !== "string"
        || hint.title.length < 1 || hint.title.length > 200
        || hint.excerpt.length > 500) return false;
      try { return assertPublicHttpsUrl(hint.url).toString() === hint.url; } catch { return false; }
    });
  const schemaValid = (row.schemaVersion === LEGACY_QUERY_PLAN_V3_VERSION
      && row.policyVersion === LEGACY_QUERY_PLAN_V3_POLICY_VERSION)
    || typedQueryPlanContractValid(row);
  return schemaValid
    && row.pipelineVersion === "corpus_first_v3"
    && typeof row.selectionPlanHash === "string"
    && /^[a-f0-9]{64}$/u.test(row.selectionPlanHash)
    && typeof row.graphSnapshotId === "string"
    && typeof row.storefront === "string"
    && /^[a-z]{2}$/u.test(row.storefront)
    && Number.isInteger(row.targetTrackCount)
    && Number(row.targetTrackCount) >= 1
    && Number(row.targetTrackCount) <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    && (
      Number(row.targetTrackCount) <= PUBLIC_PLAYLIST_MAXIMUM_TRACKS
      || row.schemaVersion === CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
    )
    && Array.isArray(row.engines)
    && row.engines.length > 0
    && row.engine === row.engines[0]
    && Array.isArray(row.membershipPredicates)
    && Array.isArray(row.rankingObjectives)
    && row.rankingObjectives.every((value) => (
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value.values === undefined || (
        Array.isArray(value.values)
        && value.values.length <= 20
        && value.values.every((seed) => typeof seed === "string" && seed.trim().length > 0 && seed.length <= 240)
      ))
    ))
    && Array.isArray(row.hardConstraints)
    && Array.isArray(row.softPreferences)
    && sourceDiscoveryHintsValid
    && continuationValid
    && corpusReviewValid;
}
