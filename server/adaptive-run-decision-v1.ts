import type { RunDecisionActionView } from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import {
  playlistInterpretationSummaryV1,
  type PlaylistInterpretationSummaryV1,
} from "./adaptive-guidance-v3.ts";
import type { PlaylistContractRevisionV1 } from "./playlist-contract-v1.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const ADAPTIVE_RUN_DECISION_SCHEMA_V1 = "genio-run-decision/v1" as const;
export const ACTIVE_COMPUTE_EXTENSION_MS_V1 = 15 * 60_000;
export const MAX_ACTIVE_COMPUTE_EXTENSIONS_V1 = 1;

export type AdaptiveRunDecisionReasonV1 =
  | "active_compute_limit"
  | "central_quality_floor"
  | "playlist_optimization_constraints"
  | "dependency_retry_window_expired"
  | "frontier_exhausted_under_policy"
  | "runtime_feasibility_unknown";

export interface AdaptiveRunDecisionPredicateV1 {
  readonly clauseId: string;
  readonly label: string;
}

export interface AdaptiveRunDecisionV1 {
  readonly schemaVersion: typeof ADAPTIVE_RUN_DECISION_SCHEMA_V1;
  readonly decisionHash: string;
  readonly contractRevisionId: string;
  readonly contractSemanticHash: string;
  readonly reason: AdaptiveRunDecisionReasonV1;
  readonly targetTrackCount: number;
  readonly verifiedTrackCount: number;
  readonly remainingStrategyCount: number;
  readonly consumedActiveComputeMs: number;
  readonly activeComputeLimitMs: number;
  readonly activeComputeExtensionsUsed: number;
  readonly namedPredicates: readonly AdaptiveRunDecisionPredicateV1[];
  readonly interpretationSummary: PlaylistInterpretationSummaryV1;
  readonly actions: {
    readonly anotherBoundedPass: boolean;
    readonly reviseNamedPredicate: boolean;
    readonly reduceCount: boolean;
    readonly publishVerifiedPartial: boolean;
    readonly pause: true;
    readonly resumeLater: boolean;
    readonly cancel: true;
  };
  readonly reachedAt: string;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function safeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

export function createAdaptiveRunDecisionV1(input: {
  contract: PlaylistContractRevisionV1;
  reason: AdaptiveRunDecisionReasonV1;
  verifiedTrackCount: number;
  remainingStrategyCount: number;
  consumedActiveComputeMs?: number;
  activeComputeLimitMs?: number;
  activeComputeExtensionsUsed?: number;
  limitingClauseIds?: readonly string[];
  reachedAt?: Date;
}): AdaptiveRunDecisionV1 {
  const targetTrackCount = boundedInteger(
    input.contract.requestedTrackCount,
    1,
    EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
    "target_track_count",
  );
  const verifiedTrackCount = boundedInteger(
    input.verifiedTrackCount,
    0,
    targetTrackCount,
    "verified_track_count",
  );
  const remainingStrategyCount = boundedInteger(
    input.remainingStrategyCount,
    0,
    1_000,
    "remaining_strategy_count",
  );
  const activeComputeLimitMs = boundedInteger(
    input.activeComputeLimitMs ?? ACTIVE_COMPUTE_EXTENSION_MS_V1,
    1,
    24 * 60 * 60_000,
    "active_compute_limit_ms",
  );
  const consumedActiveComputeMs = boundedInteger(
    input.consumedActiveComputeMs ?? 0,
    0,
    48 * 60 * 60_000,
    "consumed_active_compute_ms",
  );
  const activeComputeExtensionsUsed = boundedInteger(
    input.activeComputeExtensionsUsed ?? 0,
    0,
    MAX_ACTIVE_COMPUTE_EXTENSIONS_V1,
    "active_compute_extensions_used",
  );
  const limitingClauseIds = new Set(input.limitingClauseIds ?? []);
  const namedPredicates = input.contract.clauses
    .filter(({ id }) => limitingClauseIds.has(id))
    .map((clause) => ({
      clauseId: clause.id,
      label: safeLabel(clause.source.text || clause.values.join(", ")),
    }))
    .filter(({ label }) => label.length > 0)
    .slice(0, 5);
  const reachedAt = (input.reachedAt ?? new Date()).toISOString();
  const anotherBoundedPass = input.reason === "active_compute_limit"
    && remainingStrategyCount > 0
    && activeComputeExtensionsUsed < MAX_ACTIVE_COMPUTE_EXTENSIONS_V1;
  const partialCanRetainPolicy = input.reason === "active_compute_limit"
    || input.reason === "frontier_exhausted_under_policy";
  const body = {
    schemaVersion: ADAPTIVE_RUN_DECISION_SCHEMA_V1,
    contractRevisionId: input.contract.revisionId,
    contractSemanticHash: input.contract.semanticHash,
    reason: input.reason,
    targetTrackCount,
    verifiedTrackCount,
    remainingStrategyCount,
    consumedActiveComputeMs,
    activeComputeLimitMs,
    activeComputeExtensionsUsed,
    namedPredicates,
    interpretationSummary: playlistInterpretationSummaryV1(input.contract),
    actions: {
      anotherBoundedPass,
      reviseNamedPredicate: namedPredicates.length > 0,
      reduceCount: verifiedTrackCount > 0 && verifiedTrackCount < targetTrackCount,
      publishVerifiedPartial: partialCanRetainPolicy
        && verifiedTrackCount > 0
        && verifiedTrackCount < targetTrackCount,
      pause: true as const,
      resumeLater: input.reason === "dependency_retry_window_expired",
      cancel: true as const,
    },
    reachedAt,
  };
  return {
    ...body,
    decisionHash: sha256Hex(stableStringify(body)),
  };
}

function finiteInteger(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function stringValue(value: unknown, maximum = 180): string {
  return typeof value === "string" ? safeLabel(value).slice(0, maximum) : "";
}

function stringList(value: unknown, maximumItems = 20): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean).slice(0, maximumItems)
    : [];
}

/**
 * Positive allowlist for the capability API. A malformed or internal blocker
 * state produces no action instead of leaking data or advertising dead UI.
 */
export function publicAdaptiveRunDecisionV1(value: unknown): RunDecisionActionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const recognizedShape =
    row.schemaVersion === ADAPTIVE_RUN_DECISION_SCHEMA_V1
    || (
      row.schemaVersion === undefined
      && row.kind === "research_boundary"
    );
  if (!recognizedShape
    || typeof row.decisionHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.decisionHash)
    || typeof row.contractRevisionId !== "string"
    || typeof row.contractSemanticHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.contractSemanticHash)) {
    return null;
  }
  const reason = row.reason;
  if (reason !== "active_compute_limit"
    && reason !== "central_quality_floor"
    && reason !== "playlist_optimization_constraints"
    && reason !== "dependency_retry_window_expired"
    && reason !== "frontier_exhausted_under_policy"
    && reason !== "runtime_feasibility_unknown") {
    return null;
  }
  const targetTrackCount = finiteInteger(
    row.targetTrackCount,
    1,
    EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  );
  const verifiedTrackCount = finiteInteger(
    row.verifiedTrackCount,
    0,
    EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  );
  const remainingStrategyCount = finiteInteger(row.remainingStrategyCount, 0, 1_000);
  const consumedActiveComputeMs = finiteInteger(row.consumedActiveComputeMs, 0, 48 * 60 * 60_000);
  const activeComputeLimitMs = finiteInteger(row.activeComputeLimitMs, 1, 24 * 60 * 60_000);
  const activeComputeExtensionsUsed = finiteInteger(
    row.activeComputeExtensionsUsed,
    0,
    MAX_ACTIVE_COMPUTE_EXTENSIONS_V1,
  );
  if (targetTrackCount === null
    || verifiedTrackCount === null
    || verifiedTrackCount > targetTrackCount
    || remainingStrategyCount === null
    || consumedActiveComputeMs === null
    || activeComputeLimitMs === null
    || activeComputeExtensionsUsed === null) {
    return null;
  }
  const actionRow = row.actions && typeof row.actions === "object" && !Array.isArray(row.actions)
    ? row.actions as Record<string, unknown>
    : null;
  const summaryRow = row.interpretationSummary
    && typeof row.interpretationSummary === "object"
    && !Array.isArray(row.interpretationSummary)
    ? row.interpretationSummary as Record<string, unknown>
    : null;
  if (!actionRow || !summaryRow) return null;
  const reachedAt = stringValue(row.reachedAt, 64);
  if (!Number.isFinite(Date.parse(reachedAt))) return null;
  const namedPredicates = Array.isArray(row.namedPredicates)
    ? row.namedPredicates.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const predicate = value as Record<string, unknown>;
      const clauseId = stringValue(predicate.clauseId, 160);
      const label = stringValue(predicate.label, 180);
      return clauseId && label ? [{ clauseId, label }] : [];
    }).slice(0, 5)
    : [];
  return {
    kind: "research_boundary",
    decisionHash: row.decisionHash,
    contractRevisionId: row.contractRevisionId,
    contractSemanticHash: row.contractSemanticHash,
    reason,
    targetTrackCount,
    verifiedTrackCount,
    remainingStrategyCount,
    consumedActiveComputeMs,
    activeComputeLimitMs,
    activeComputeExtensionsUsed,
    namedPredicates,
    interpretationSummary: {
      mustHave: stringList(summaryRow.mustHave),
      prefer: stringList(summaryRow.prefer),
      avoid: stringList(summaryRow.avoid),
      flow: stringList(summaryRow.flow),
      count: targetTrackCount,
    },
    actions: {
      anotherBoundedPass: actionRow.anotherBoundedPass === true,
      reviseNamedPredicate: actionRow.reviseNamedPredicate === true && namedPredicates.length > 0,
      reduceCount: actionRow.reduceCount === true,
      publishVerifiedPartial: actionRow.publishVerifiedPartial === true,
      pause: actionRow.pause === true,
      resumeLater: actionRow.resumeLater === true,
      cancel: actionRow.cancel === true,
    },
    reachedAt: new Date(Date.parse(reachedAt)).toISOString(),
  };
}
