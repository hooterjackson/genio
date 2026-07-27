import type { RunStatus } from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import { playlistCandidateGoalV1 } from "./playlist-feasibility-v1.ts";

export const DEPENDENCY_RETRY_DELAYS_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;
export const DEPENDENCY_AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60_000;
export const ACTIVE_RESEARCH_LIMIT_MS = 15 * 60_000;
export const INTERACTIVE_PROGRESS_SLO_MS = 2 * 60_000;

export type NeverDeadEndRunState =
  | "accepted"
  | "needs_input"
  | "probing"
  | "executing"
  | "blocked_dependency"
  | "needs_decision"
  | "ready"
  | "publishing"
  | "completed"
  | "cancelled"
  | "quarantined";

export type RunNextAction =
  | "none"
  | "answer_initial_guidance"
  | "answer_rescue_guidance"
  | "wait_for_dependency"
  | "resume_research"
  | "authorize_apple"
  | "decide_verified_partial"
  | "review_contract"
  | "contact_support";

export interface NeverDeadEndProjection {
  state: NeverDeadEndRunState;
  nextAction: RunNextAction;
  terminal: boolean;
}

/**
 * Compatibility projection for legacy rows. New orchestration persists stage
 * and blocker independently, but old rows must still render as an honest
 * action rather than a misleading terminal scarcity result.
 */
export function projectNeverDeadEndRun(input: {
  status: RunStatus;
  phase?: string | null;
  retryableDependency?: boolean;
  rescueQuestionsAvailable?: boolean;
}): NeverDeadEndProjection {
  const phase = input.phase?.toLowerCase() ?? "";
  if (input.status === "complete") {
    return { state: "completed", nextAction: "none", terminal: true };
  }
  if (input.status === "cancelled" || input.status === "deleted" || input.status === "expired") {
    return { state: "cancelled", nextAction: "none", terminal: true };
  }
  if (input.status === "failed_integrity") {
    return { state: "quarantined", nextAction: "contact_support", terminal: false };
  }
  if (input.status === "waiting_for_apple_authorization") {
    return { state: "blocked_dependency", nextAction: "authorize_apple", terminal: false };
  }
  if (input.status === "awaiting_guidance") {
    return {
      state: "needs_input",
      nextAction: phase.includes("rescue") ? "answer_rescue_guidance" : "answer_initial_guidance",
      terminal: false,
    };
  }
  if (input.status === "partial_ready" || input.status === "partial") {
    return { state: "needs_decision", nextAction: "decide_verified_partial", terminal: false };
  }
  if (input.status === "needs_decision") {
    return { state: "needs_decision", nextAction: "review_contract", terminal: false };
  }
  if (input.status === "no_compatible_tracks") {
    return {
      state: "needs_decision",
      nextAction: input.rescueQuestionsAvailable === false ? "review_contract" : "answer_rescue_guidance",
      terminal: false,
    };
  }
  if (input.status === "failed_system" || input.status === "failed") {
    return input.retryableDependency
      ? { state: "blocked_dependency", nextAction: "wait_for_dependency", terminal: false }
      : { state: "quarantined", nextAction: "contact_support", terminal: false };
  }
  if (input.status === "manifest_ready") {
    return { state: "ready", nextAction: "none", terminal: false };
  }
  if (input.status === "publishing") {
    return { state: "publishing", nextAction: "none", terminal: false };
  }
  if (input.status === "draft" || input.status === "queued" || input.status === "awaiting_budget") {
    return {
      state: input.status === "awaiting_budget" ? "needs_decision" : "accepted",
      nextAction: input.status === "awaiting_budget" ? "review_contract" : "none",
      terminal: false,
    };
  }
  if (input.status === "researching" || input.status === "continuing_research") {
    return { state: "executing", nextAction: "none", terminal: false };
  }
  if (input.status === "ready_for_matching" || input.status === "matching" || input.status === "resolving_catalog") {
    return { state: "executing", nextAction: "none", terminal: false };
  }
  if (input.status === "review" || input.status === "visitor_review" || input.status === "waiting_for_corpus_review") {
    return { state: "needs_decision", nextAction: "review_contract", terminal: false };
  }
  return { state: "probing", nextAction: "none", terminal: false };
}

export interface DependencyRetryDecision {
  retry: boolean;
  nextRetryAt: Date | null;
  automaticRetryUntil: Date;
  needsDecision: boolean;
  /** True when the queued wake may transition state but must not call a provider. */
  decisionOnlyWake: boolean;
}

export function dependencyRetryDecision(input: {
  blockedAt: Date;
  retryCount: number;
  now?: Date;
  retryAfterUntil?: Date | null;
}): DependencyRetryDecision {
  const now = input.now ?? new Date();
  const automaticRetryUntil = new Date(input.blockedAt.getTime() + DEPENDENCY_AUTOMATIC_RETRY_WINDOW_MS);
  if (now.getTime() >= automaticRetryUntil.getTime()) {
    return {
      retry: false,
      nextRetryAt: null,
      automaticRetryUntil,
      needsDecision: true,
      decisionOnlyWake: false,
    };
  }
  const index = Math.max(0, Math.floor(input.retryCount));
  const retryDelay = DEPENDENCY_RETRY_DELAYS_MS[index];
  if (retryDelay === undefined) {
    return {
      retry: false,
      nextRetryAt: automaticRetryUntil,
      automaticRetryUntil,
      needsDecision: false,
      decisionOnlyWake: true,
    };
  }
  const scheduled = new Date(input.blockedAt.getTime() + retryDelay);
  const providerRetryAt = Math.max(
    scheduled.getTime(),
    now.getTime(),
    input.retryAfterUntil?.getTime() ?? 0,
  );
  if (providerRetryAt >= automaticRetryUntil.getTime()) {
    return {
      retry: false,
      nextRetryAt: automaticRetryUntil,
      automaticRetryUntil,
      needsDecision: false,
      decisionOnlyWake: true,
    };
  }
  return {
    retry: true,
    nextRetryAt: new Date(providerRetryAt),
    automaticRetryUntil,
    needsDecision: false,
    decisionOnlyWake: false,
  };
}

export function curatedCandidateGoal(input: {
  target: number;
  p10QualifiedToAppleSafeRate: number | null | undefined;
}): number {
  const target = Math.max(
    1,
    Math.min(EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS, Math.floor(input.target)),
  );
  const observed = Number(input.p10QualifiedToAppleSafeRate);
  return playlistCandidateGoalV1(target, Number.isFinite(observed) ? observed : 0.5).candidateGoal;
}

export interface BackendCapabilityDeclaration {
  backend: string;
  predicateOperators: readonly string[];
  /**
   * Exact hard-clause shapes for which the backend can establish that a
   * positive claim is absent from a closed-world source. Entries are
   * `<clause-operator>:<clause-kind>:<axis>`. Generic Boolean NOT/EXCEPT
   * support is insufficient: an open-world semantic source can prove a
   * positive genre assertion, but cannot prove that no such assertion exists.
   */
  closedWorldNegativePredicates?: readonly string[];
  evidenceGrades: readonly string[];
  supportsQuotas: boolean;
  supportsSequencing: boolean;
  storefronts: readonly string[] | "all";
  /** Contract snapshot versions are executable policy, not informational metadata. */
  contractSchemaVersions?: readonly number[];
  compilerVersions?: readonly string[];
  ontologyVersions?: readonly string[];
  evidencePolicyVersions?: readonly string[];
  /** Exact evidence-floor comparison semantics implemented by this backend. */
  evidenceStrengthPolicyVersions?: readonly string[];
  questionTemplateVersions?: readonly string[];
  catalogPolicyVersions?: readonly string[];
  locales?: readonly string[] | "all";
  /** A quota backend must support both the Boolean shape and the governed metadata axis. */
  quotaPredicateOperators?: readonly string[];
  quotaAxes?: readonly string[];
  /** Exact canonical clause shapes accepted as quota predicate leaves. */
  quotaPredicateLeafShapes?: readonly string[];
  /** Catalog-version clauses include recording/version and content-policy gates. */
  catalogPolicyAxes?: readonly string[];
  sequencingDirections?: readonly string[];
  sequencingDimensions?: readonly string[];
  /** Typed discovery/routing semantics supported without prompt reparsing. */
  executionFeatures?: readonly string[];
}

export interface ContractCapabilityRequirements {
  predicateOperators: readonly string[];
  /** Closed-world negative proof required by NOT/EXCEPT or an exclusion leaf. */
  negativePredicateRequirements?: readonly string[];
  evidenceGrades: readonly string[];
  requiresQuotas: boolean;
  requiresSequencing: boolean;
  storefront: string;
  contractSchemaVersion?: number;
  compilerVersion?: string;
  ontologyVersion?: string;
  evidencePolicyVersion?: string;
  evidenceStrengthPolicyVersion?: string;
  questionTemplateVersion?: string;
  catalogPolicyVersion?: string;
  locale?: string;
  quotaPredicateOperators?: readonly string[];
  quotaAxes?: readonly string[];
  quotaPredicateLeafShapes?: readonly string[];
  catalogPolicyAxes?: readonly string[];
  sequencingDirections?: readonly string[];
  sequencingDimensions?: readonly string[];
  executionFeatures?: readonly string[];
}

export interface BackendCapabilityResult {
  supported: boolean;
  missing: string[];
}

export function backendSupportsContract(
  backend: BackendCapabilityDeclaration,
  contract: ContractCapabilityRequirements,
): BackendCapabilityResult {
  const operators = new Set(backend.predicateOperators);
  const closedWorldNegatives = new Set(
    backend.closedWorldNegativePredicates ?? [],
  );
  const evidence = new Set(backend.evidenceGrades);
  const missingVersion = (
    required: number | string | undefined,
    supported: readonly (number | string)[] | undefined,
    label: string,
  ): string[] => required === undefined || supported?.includes(required)
    ? []
    : [`${label}:${required}`];
  const missing = [
    ...contract.predicateOperators.filter((value) => !operators.has(value)).map((value) => `operator:${value}`),
    ...(contract.negativePredicateRequirements ?? [])
      .filter((value) => !closedWorldNegatives.has(value))
      .map((value) => `negative_predicate:${value}`),
    ...contract.evidenceGrades.filter((value) => !evidence.has(value)).map((value) => `evidence:${value}`),
    ...missingVersion(
      contract.contractSchemaVersion,
      backend.contractSchemaVersions,
      "contract_schema",
    ),
    ...missingVersion(contract.compilerVersion, backend.compilerVersions, "compiler"),
    ...missingVersion(contract.ontologyVersion, backend.ontologyVersions, "ontology"),
    ...missingVersion(
      contract.evidencePolicyVersion,
      backend.evidencePolicyVersions,
      "evidence_policy",
    ),
    ...missingVersion(
      contract.evidenceStrengthPolicyVersion,
      backend.evidenceStrengthPolicyVersions,
      "evidence_strength_policy",
    ),
    ...missingVersion(
      contract.questionTemplateVersion,
      backend.questionTemplateVersions,
      "question_templates",
    ),
    ...missingVersion(
      contract.catalogPolicyVersion,
      backend.catalogPolicyVersions,
      "catalog_policy_version",
    ),
  ];
  if (contract.requiresQuotas) {
    if (!backend.supportsQuotas) {
      missing.push("feature:quotas");
    } else {
      const quotaOperators = new Set(backend.quotaPredicateOperators ?? []);
      const quotaAxes = new Set(backend.quotaAxes ?? []);
      const quotaLeafShapes = new Set(
        backend.quotaPredicateLeafShapes ?? [],
      );
      missing.push(
        ...(contract.quotaPredicateOperators ?? [])
          .filter((value) => !quotaOperators.has(value))
          .map((value) => `quota_operator:${value}`),
        ...(contract.quotaAxes ?? [])
          .filter((value) => !quotaAxes.has(value))
          .map((value) => `quota_axis:${value}`),
        ...(contract.quotaPredicateLeafShapes ?? [])
          .filter((value) => !quotaLeafShapes.has(value))
          .map((value) => `quota_leaf:${value}`),
      );
    }
  }
  const catalogAxes = new Set(backend.catalogPolicyAxes ?? []);
  missing.push(...(contract.catalogPolicyAxes ?? [])
    .filter((value) => !catalogAxes.has(value))
    .map((value) => `catalog_policy:${value}`));
  const executionFeatures = new Set(backend.executionFeatures ?? []);
  missing.push(...(contract.executionFeatures ?? [])
    .filter((value) => !executionFeatures.has(value))
    .map((value) => `execution_feature:${value}`));
  if (contract.requiresSequencing) {
    if (!backend.supportsSequencing) {
      missing.push("feature:sequencing");
    } else {
      const directions = new Set(backend.sequencingDirections ?? []);
      const dimensions = new Set(backend.sequencingDimensions ?? []);
      missing.push(
        ...(contract.sequencingDirections ?? [])
          .filter((value) => !directions.has(value))
          .map((value) => `sequencing_direction:${value}`),
        ...(contract.sequencingDimensions ?? [])
          .filter((value) => !dimensions.has(value))
          .map((value) => `sequencing_dimension:${value}`),
      );
    }
  }
  if (backend.storefronts !== "all" && !backend.storefronts.includes(contract.storefront)) {
    missing.push(`storefront:${contract.storefront}`);
  }
  if (contract.locale && backend.locales !== "all" && !backend.locales?.includes(contract.locale)) {
    missing.push(`locale:${contract.locale}`);
  }
  return { supported: missing.length === 0, missing: [...new Set(missing)].sort() };
}
