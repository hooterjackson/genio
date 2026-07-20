import { createHash } from "node:crypto";
import type {
  PipelineV3SourceDiscoveryHint,
  QueryPlanV3,
  QueryPlanV3Engine,
  SelectionConstraint,
  SelectionConstraintAxis,
  SelectionConstraintOperator,
} from "../shared/types.ts";
import {
  PIPELINE_V3_MAX_SOURCE_DISCOVERY_HINTS,
  selectionPlanV3Hash,
  type MembershipAxisV3,
  type MembershipOperatorV3,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import { assertPublicHttpsUrl, stableStringify } from "./security.ts";

export const QUERY_PLAN_V3_VERSION = 1 as const;
export const QUERY_PLAN_V3_POLICY_VERSION = "corpus_first_v3_policy_v1" as const;

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
    | "factual_feasibility_required"
    | "sticky_rollout"
    | "control";
}

const MEMBERSHIP_AXIS: Record<MembershipAxisV3, SelectionConstraintAxis> = {
  genre: "genre",
  subgenre: "subgenre",
  scene: "scene",
  era: "era",
  geography: "geography",
  language: "language",
  theme: "theme",
  mood: "mood",
  activity: "activity",
  artist: "artist",
  track: "track",
  label: "label",
  venue: "venue",
  factual_relationship: "relationship",
  recording_version: "recording_version",
  content: "content",
};

const MEMBERSHIP_OPERATOR: Record<MembershipOperatorV3, SelectionConstraintOperator> = {
  include: "include",
  exclude: "exclude",
  require: "require",
};

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
    ? Math.max(1, Math.min(300, configuredMaximum))
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
  if (input.owner && ownerCanaryAllows(input.plan, group, env)) {
    return { assigned: true, cohort, percentage: 100, group, reason: "owner_canary" };
  }
  if (env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED !== "true") {
    return { assigned: false, cohort, percentage: 0, group, reason: "production_evidence_required" };
  }
  if ((group === "factual_relationship" || group === "exhaustive")
    && env.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED !== "true") {
    return { assigned: false, cohort, percentage: 0, group, reason: "factual_feasibility_required" };
  }
  const percentage = boundedPercentage(env[rolloutVariable(group)]);
  const assigned = cohort < Math.round(percentage * 100);
  return { assigned, cohort, percentage, group, reason: assigned ? "sticky_rollout" : "control" };
}

function hardConstraint(plan: SelectionPlanV3, index: number): SelectionConstraint {
  const predicate = plan.membershipPredicates[index]!;
  return {
    id: predicate.id,
    axis: MEMBERSHIP_AXIS[predicate.axis],
    operator: MEMBERSHIP_OPERATOR[predicate.operator],
    values: [...predicate.values],
    kind: "hard",
    relaxationRank: null,
  };
}

function constraintKey(value: SelectionConstraint): string {
  return `${value.axis}:${value.operator}:${value.kind}:${value.values.join("|")}:${value.geographyRelationship ?? ""}`;
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

export function createQueryPlanV3(plan: SelectionPlanV3, graphSnapshotId: string): QueryPlanV3 {
  if (!plan.confirmed || plan.criticalAmbiguities.some(({ key }) => !plan.resolvedAmbiguityKeys.includes(key))) {
    throw new Error("Critical playlist ambiguity must be resolved before a V3 query plan is created");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(graphSnapshotId)) {
    throw new Error("A locked graph snapshot id is required");
  }
  const engines = queryPlanV3Engines(plan);
  return Object.freeze({
    schemaVersion: QUERY_PLAN_V3_VERSION,
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
    })),
    targetTrackCount: plan.requestedTrackCount,
    storefront: plan.storefront,
    hardConstraints: distinctConstraints([
      ...plan.membershipPredicates.map((_, index) => hardConstraint(plan, index)),
      ...plan.hardConstraints,
    ]),
    softPreferences: distinctConstraints(plan.softPreferences),
    sourceDiscoveryHints: plan.sourceDiscoveryHints.map((hint) => ({ ...hint })),
    scopeKind: plan.scopeKind,
    diversityGoals: { ...plan.diversityGoals },
    orderingPolicy: { ...plan.orderingPolicy, goals: [...plan.orderingPolicy.goals] },
    softGoalRelaxationOrder: [...plan.softGoalRelaxationOrder],
  });
}

export function queryPlanV3Hash(plan: QueryPlanV3): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
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
  return row.schemaVersion === 1
    && row.pipelineVersion === "corpus_first_v3"
    && row.policyVersion === QUERY_PLAN_V3_POLICY_VERSION
    && typeof row.selectionPlanHash === "string"
    && /^[a-f0-9]{64}$/u.test(row.selectionPlanHash)
    && typeof row.graphSnapshotId === "string"
    && typeof row.storefront === "string"
    && /^[a-z]{2}$/u.test(row.storefront)
    && Number.isInteger(row.targetTrackCount)
    && Number(row.targetTrackCount) >= 1
    && Number(row.targetTrackCount) <= 300
    && Array.isArray(row.engines)
    && row.engines.length > 0
    && row.engine === row.engines[0]
    && Array.isArray(row.membershipPredicates)
    && Array.isArray(row.rankingObjectives)
    && Array.isArray(row.hardConstraints)
    && Array.isArray(row.softPreferences)
    && sourceDiscoveryHintsValid
    && continuationValid
    && corpusReviewValid;
}
