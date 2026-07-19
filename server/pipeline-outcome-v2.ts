import type {
  PipelineDeficitKind,
  PipelineDeficitLedgerEntry,
  PipelineOutcome,
  PipelineOutcomeStatus,
  PipelinePolicyVersion,
  PipelineVersion,
} from "../shared/types.ts";
import {
  buildPipelineStageLedger,
  type PipelineStageCounts,
} from "./pipeline-v2-observability.ts";
import type { CatalogDiscoveryStopReason } from "./catalog-discovery-v2.ts";

export interface CatalogDiscoveryOutcomeDisposition {
  status: PipelineOutcomeStatus;
  reasonCode: string;
  frontierExhausted: boolean;
  providerUnavailable: boolean;
}

/**
 * Deterministic translation from catalog-frontier completion into the public
 * completeness vocabulary. A zero-track result remains a non-system outcome,
 * while its reason code retains the exact cause for operations and replay.
 */
export function catalogDiscoveryOutcomeDisposition(input: {
  stoppedBecause: CatalogDiscoveryStopReason;
  safeTrackCount: number;
  targetTrackCount: number;
}): CatalogDiscoveryOutcomeDisposition {
  const safeTrackCount = boundedCount(input.safeTrackCount);
  const targetTrackCount = boundedCount(input.targetTrackCount);
  if (input.stoppedBecause === "target_and_reserve" && safeTrackCount >= targetTrackCount) {
    return {
      status: "complete",
      reasonCode: "catalog_target_and_reserve_satisfied",
      frontierExhausted: false,
      providerUnavailable: false,
    };
  }
  const typed: Record<Exclude<CatalogDiscoveryStopReason, "target_and_reserve">, Omit<CatalogDiscoveryOutcomeDisposition, "status"> & {
    partialStatus: PipelineOutcomeStatus;
  }> = {
    provider_call_limit: {
      partialStatus: "partial_catalog_degraded",
      reasonCode: "catalog_provider_call_limit",
      frontierExhausted: false,
      providerUnavailable: false,
    },
    timed_out: {
      partialStatus: "partial_timed_out",
      reasonCode: "catalog_discovery_timed_out",
      frontierExhausted: false,
      providerUnavailable: false,
    },
    aborted: {
      partialStatus: "cancelled",
      reasonCode: "catalog_discovery_aborted",
      frontierExhausted: false,
      providerUnavailable: false,
    },
    provider_circuit_open: {
      partialStatus: "partial_catalog_degraded",
      reasonCode: "apple_provider_circuit_open",
      frontierExhausted: false,
      providerUnavailable: true,
    },
    provider_degraded: {
      partialStatus: "partial_catalog_degraded",
      reasonCode: "apple_provider_degraded",
      frontierExhausted: false,
      providerUnavailable: true,
    },
    policy_conflict: {
      partialStatus: "partial_policy_conflict",
      reasonCode: "catalog_version_policy_conflict",
      frontierExhausted: true,
      providerUnavailable: false,
    },
    zero_yield_exhausted: {
      partialStatus: "partial_frontier_exhausted",
      reasonCode: "catalog_zero_yield_frontier_exhausted",
      frontierExhausted: true,
      providerUnavailable: false,
    },
    frontier_exhausted: {
      partialStatus: "partial_frontier_exhausted",
      reasonCode: "catalog_frontier_exhausted",
      frontierExhausted: true,
      providerUnavailable: false,
    },
  };
  const disposition = input.stoppedBecause === "target_and_reserve"
    ? {
        partialStatus: "partial_evidence_shortfall" as const,
        reasonCode: "catalog_reserve_satisfied_but_safe_target_shortfall",
        frontierExhausted: false,
        providerUnavailable: false,
      }
    : typed[input.stoppedBecause];
  return {
    status: safeTrackCount === 0 && disposition.partialStatus !== "cancelled"
      ? "no_compatible_tracks"
      : disposition.partialStatus,
    reasonCode: disposition.reasonCode,
    frontierExhausted: disposition.frontierExhausted,
    providerUnavailable: disposition.providerUnavailable,
  };
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function deficitKind(status: PipelineOutcomeStatus): PipelineDeficitKind {
  if (status === "partial_evidence_shortfall") return "evidence";
  if (status === "partial_policy_conflict") return "version_policy";
  if (status === "partial_frontier_exhausted") return "source_frontier";
  return "catalog_availability";
}

const STATUS_PRECEDENCE: Record<PipelineOutcomeStatus, number> = {
  complete: 100,
  partial_frontier_exhausted: 90,
  partial_evidence_shortfall: 89,
  partial_catalog_degraded: 88,
  partial_timed_out: 87,
  partial_policy_conflict: 86,
  no_compatible_tracks: 80,
  waiting_for_owner_authorization: 70,
  failed_integrity: 20,
  failed_system: 10,
  cancelled: 0,
};

function outcomePrecedence(outcome: PipelineOutcome): readonly number[] {
  return [
    boundedCount(outcome.publishedTrackCount),
    boundedCount(outcome.selectedTrackCount),
    boundedCount(outcome.qualifiedTrackCount),
    boundedCount(outcome.discoveredTrackCount),
    STATUS_PRECEDENCE[outcome.status],
  ];
}

function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function deficitKey(entry: PipelineDeficitLedgerEntry): string {
  return `${entry.stage}\u0000${entry.kind}`;
}

function mergeDeficits(
  left: readonly PipelineDeficitLedgerEntry[],
  right: readonly PipelineDeficitLedgerEntry[],
): PipelineDeficitLedgerEntry[] {
  const byKey = new Map<string, PipelineDeficitLedgerEntry>();
  for (const entry of [...left, ...right]) {
    const key = deficitKey(entry);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...entry, detail: { ...entry.detail } });
      continue;
    }
    const statusRank = { open: 0, waived: 1, exhausted: 2, resolved: 3 } as const;
    const progressComparison = compareNumbers(
      [statusRank[entry.status], boundedCount(entry.actualCount)],
      [statusRank[prior.status], boundedCount(prior.actualCount)],
    );
    const entryTieBreak = `${entry.observedAt}\u0000${entry.reasonCode}\u0000${JSON.stringify(entry.detail)}`;
    const priorTieBreak = `${prior.observedAt}\u0000${prior.reasonCode}\u0000${JSON.stringify(prior.detail)}`;
    const entryWinsDetail = progressComparison > 0
      || (progressComparison === 0 && entryTieBreak > priorTieBreak);
    const requiredCount = Math.max(boundedCount(prior.requiredCount), boundedCount(entry.requiredCount));
    const actualCount = Math.max(boundedCount(prior.actualCount), boundedCount(entry.actualCount));
    const status = statusRank[entry.status] > statusRank[prior.status] ? entry.status : prior.status;
    byKey.set(key, {
      ...prior,
      status,
      requiredCount,
      actualCount,
      deficitCount: status === "resolved" ? 0 : Math.max(0, requiredCount - actualCount),
      reasonCode: entryWinsDetail ? entry.reasonCode : prior.reasonCode,
      detail: entryWinsDetail ? { ...entry.detail } : { ...prior.detail },
      observedAt: entry.observedAt > prior.observedAt ? entry.observedAt : prior.observedAt,
    });
  }
  return [...byKey.values()].sort((leftEntry, rightEntry) => (
    deficitKey(leftEntry).localeCompare(deficitKey(rightEntry))
  ));
}

/**
 * Commutative, deterministic merge for retries and out-of-order workers.
 * Version and target identity are immutable; stage progress is component-wise
 * monotonic and a published/complete result cannot be replaced by a late
 * lower-progress failure.
 */
export function mergePipelineOutcomes(
  left: PipelineOutcome,
  right: PipelineOutcome,
): PipelineOutcome {
  if (left.pipelineVersion !== right.pipelineVersion || left.policyVersion !== right.policyVersion) {
    throw new Error("Pipeline outcome versions are immutable");
  }
  if (boundedCount(left.targetTrackCount) !== boundedCount(right.targetTrackCount)) {
    throw new Error("Pipeline outcome target is immutable");
  }
  const winnerComparison = compareNumbers(outcomePrecedence(left), outcomePrecedence(right));
  const winner = winnerComparison > 0
    ? left
    : winnerComparison < 0
      ? right
      : left.status.localeCompare(right.status) >= 0 ? left : right;
  const targetTrackCount = boundedCount(left.targetTrackCount);
  const discoveredTrackCount = Math.max(
    boundedCount(left.discoveredTrackCount),
    boundedCount(right.discoveredTrackCount),
  );
  const qualifiedTrackCount = Math.min(discoveredTrackCount, Math.max(
    boundedCount(left.qualifiedTrackCount),
    boundedCount(right.qualifiedTrackCount),
  ));
  const selectedTrackCount = Math.min(qualifiedTrackCount, Math.max(
    boundedCount(left.selectedTrackCount),
    boundedCount(right.selectedTrackCount),
  ));
  const publishedTrackCount = Math.min(selectedTrackCount, Math.max(
    boundedCount(left.publishedTrackCount),
    boundedCount(right.publishedTrackCount),
  ));
  const exactCountSatisfied = targetTrackCount > 0 && publishedTrackCount >= targetTrackCount;
  return {
    schemaVersion: 1,
    pipelineVersion: left.pipelineVersion,
    policyVersion: left.policyVersion,
    status: exactCountSatisfied ? "complete" : winner.status,
    targetTrackCount,
    discoveredTrackCount,
    qualifiedTrackCount,
    selectedTrackCount,
    publishedTrackCount,
    exactCountSatisfied,
    frontierExhausted: left.frontierExhausted || right.frontierExhausted,
    providerUnavailable: left.providerUnavailable || right.providerUnavailable,
    reasonCodes: [...new Set([...left.reasonCodes, ...right.reasonCodes])].sort(),
    deficits: mergeDeficits(left.deficits, right.deficits),
    completedAt: left.completedAt > right.completedAt ? left.completedAt : right.completedAt,
  };
}

export function buildPipelineOutcome(input: {
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  status: PipelineOutcomeStatus;
  targetTrackCount: number;
  discoveredTrackCount: number;
  qualifiedTrackCount: number;
  selectedTrackCount: number;
  publishedTrackCount: number;
  frontierExhausted?: boolean;
  providerUnavailable?: boolean;
  reasonCodes?: string[];
  stageCounts?: PipelineStageCounts;
  completedAt?: string;
}): PipelineOutcome {
  const targetTrackCount = boundedCount(input.targetTrackCount);
  const discoveredTrackCount = boundedCount(input.discoveredTrackCount);
  const qualifiedTrackCount = Math.min(discoveredTrackCount, boundedCount(input.qualifiedTrackCount));
  const selectedTrackCount = Math.min(qualifiedTrackCount, boundedCount(input.selectedTrackCount));
  const publishedTrackCount = Math.min(selectedTrackCount, boundedCount(input.publishedTrackCount));
  const completedAt = input.completedAt ?? new Date().toISOString();
  const reasonCodes = [...new Set((input.reasonCodes ?? []).map((reason) => reason.trim()).filter(Boolean))];
  const fallbackStageCounts: PipelineStageCounts = {
    discovered: discoveredTrackCount,
    scope_qualified: qualifiedTrackCount,
    claim_verified: qualifiedTrackCount,
    version_compatible: qualifiedTrackCount,
    catalog_resolved: selectedTrackCount,
    playable: selectedTrackCount,
    canonicalized: selectedTrackCount,
    quota_eligible: selectedTrackCount,
    sequenced: selectedTrackCount,
    manifested: selectedTrackCount,
    published: publishedTrackCount,
  };
  // Legacy callers have no durable stage history, so preserve their
  // compatibility projection only when no stage counts were supplied. Once
  // a caller opts into durable accounting, an omitted stage means no
  // candidate reached it; synthesizing that stage from selected/qualified
  // totals would hide the exact point where candidates were lost.
  const stageCounts = input.stageCounts == null
    ? fallbackStageCounts
    : { ...input.stageCounts };
  const reasonCode = reasonCodes[0] ?? input.status;
  const deficits = buildPipelineStageLedger({
    targetTrackCount,
    stageCounts,
    exhausted: input.frontierExhausted === true,
    reasonCodes: {
      discovered: reasonCode,
      scope_qualified: input.status === "partial_evidence_shortfall" ? reasonCode : undefined,
      claim_verified: input.status === "partial_evidence_shortfall" ? reasonCode : undefined,
      version_compatible: input.status === "partial_policy_conflict" ? reasonCode : undefined,
      catalog_resolved: input.status === "partial_catalog_degraded" ? reasonCode : undefined,
      playable: input.status === "partial_catalog_degraded" ? reasonCode : undefined,
      canonicalized: input.status === "partial_policy_conflict" ? reasonCode : undefined,
      quota_eligible: reasonCode,
      sequenced: reasonCode,
      manifested: reasonCode,
      published: reasonCode,
    },
    detail: {
      published: { outcomeStatus: input.status, deficitKind: deficitKind(input.status) },
    },
    observedAt: completedAt,
  });
  return {
    schemaVersion: 1,
    pipelineVersion: input.pipelineVersion,
    policyVersion: input.policyVersion,
    status: input.status,
    targetTrackCount,
    discoveredTrackCount,
    qualifiedTrackCount,
    selectedTrackCount,
    publishedTrackCount,
    exactCountSatisfied: targetTrackCount > 0 && publishedTrackCount === targetTrackCount,
    frontierExhausted: input.frontierExhausted === true,
    providerUnavailable: input.providerUnavailable === true,
    reasonCodes,
    deficits,
    completedAt,
  };
}
