import type {
  CandidateStage,
  PipelineDeficitKind,
  PipelineDeficitLedgerEntry,
  PipelineDeficitStatus,
} from "../shared/types.ts";

export const PIPELINE_LEDGER_STAGES = [
  "discovered",
  "scope_qualified",
  "claim_verified",
  "version_compatible",
  "catalog_resolved",
  "playable",
  "canonicalized",
  "quota_eligible",
  "sequenced",
  "manifested",
  "published",
] as const satisfies readonly CandidateStage[];

export type PipelineLedgerStage = (typeof PIPELINE_LEDGER_STAGES)[number];
export type PipelineStageCounts = Partial<Record<PipelineLedgerStage, number>>;

const STAGE_KIND: Record<PipelineLedgerStage, PipelineDeficitKind> = {
  discovered: "candidate_pool",
  scope_qualified: "scope_relevance",
  claim_verified: "evidence",
  version_compatible: "version_policy",
  catalog_resolved: "catalog_availability",
  playable: "catalog_availability",
  canonicalized: "recording_identity",
  quota_eligible: "artist_breadth",
  sequenced: "candidate_pool",
  manifested: "catalog_availability",
  published: "catalog_availability",
};

function count(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function boundedReasonCode(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return normalized || fallback;
}

/**
 * Builds a complete, monotonic stage ledger. Counts may only decrease as a
 * candidate pool advances, which makes the exact point of loss auditable.
 */
export function buildPipelineStageLedger(input: {
  targetTrackCount: number;
  stageCounts: PipelineStageCounts;
  exhausted?: boolean;
  waivedStages?: readonly PipelineLedgerStage[];
  reasonCodes?: Partial<Record<PipelineLedgerStage, string>>;
  detail?: Partial<Record<PipelineLedgerStage, Record<string, unknown>>>;
  observedAt?: string;
}): PipelineDeficitLedgerEntry[] {
  const target = count(input.targetTrackCount);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const waived = new Set(input.waivedStages ?? []);
  let prior = Number.POSITIVE_INFINITY;

  return PIPELINE_LEDGER_STAGES.map((stage) => {
    const actual = Math.min(prior, count(input.stageCounts[stage]));
    prior = actual;
    const deficit = Math.max(0, target - actual);
    let status: PipelineDeficitStatus = deficit === 0 ? "resolved" : input.exhausted ? "exhausted" : "open";
    if (waived.has(stage)) status = "waived";
    return {
      stage,
      kind: STAGE_KIND[stage],
      status,
      requiredCount: target,
      actualCount: actual,
      deficitCount: status === "waived" ? 0 : deficit,
      reasonCode: boundedReasonCode(
        input.reasonCodes?.[stage],
        deficit === 0 ? `${stage}_target_satisfied` : `${stage}_shortfall`,
      ),
      detail: { ...(input.detail?.[stage] ?? {}) },
      observedAt,
    };
  });
}

export type PipelineOperationalAlertKind =
  | "pipeline_zero_result_spike"
  | "pipeline_partial_rate_elevated"
  | "pipeline_local_contract_rejections"
  | "pipeline_provider_circuit_repeated"
  | "pipeline_pagination_loop"
  | "pipeline_endpoint_drift"
  | "pipeline_publication_divergence";

export interface PipelineOperationalWindow {
  windowStartedAt: string;
  windowEndedAt: string;
  terminalRuns: number;
  zeroResultRuns: number;
  partialRuns: number;
  localContractRejections: number;
  providerCircuitOpenings: number;
  paginationLoops: number;
  endpointDriftEvents: number;
  publicationDivergences: number;
}

export interface PipelineOperationalAlert {
  kind: PipelineOperationalAlertKind;
  count: number;
  rate: number | null;
  threshold: number;
  windowStartedAt: string;
  windowEndedAt: string;
}

export interface PipelineOperationalSweepResult {
  window: PipelineOperationalWindow;
  alerts: PipelineOperationalAlert[];
  notificationIds: string[];
}

/** Pure threshold policy used by both the worker sweep and replay tests. */
export function evaluatePipelineOperationalWindow(
  input: PipelineOperationalWindow,
): PipelineOperationalAlert[] {
  const terminalRuns = count(input.terminalRuns);
  const alerts: PipelineOperationalAlert[] = [];
  const appendRate = (
    kind: PipelineOperationalAlertKind,
    value: number,
    minimumCount: number,
    threshold: number,
  ) => {
    const normalized = count(value);
    const rate = terminalRuns > 0 ? normalized / terminalRuns : 0;
    if (normalized >= minimumCount && rate >= threshold) {
      alerts.push({
        kind,
        count: normalized,
        rate,
        threshold,
        windowStartedAt: input.windowStartedAt,
        windowEndedAt: input.windowEndedAt,
      });
    }
  };
  const appendCount = (
    kind: PipelineOperationalAlertKind,
    value: number,
    threshold: number,
  ) => {
    const normalized = count(value);
    if (normalized >= threshold) {
      alerts.push({
        kind,
        count: normalized,
        rate: null,
        threshold,
        windowStartedAt: input.windowStartedAt,
        windowEndedAt: input.windowEndedAt,
      });
    }
  };

  appendRate("pipeline_zero_result_spike", input.zeroResultRuns, 3, 0.15);
  appendRate("pipeline_partial_rate_elevated", input.partialRuns, 5, 0.30);
  appendCount("pipeline_local_contract_rejections", input.localContractRejections, 2);
  appendCount("pipeline_provider_circuit_repeated", input.providerCircuitOpenings, 3);
  appendCount("pipeline_pagination_loop", input.paginationLoops, 1);
  appendCount("pipeline_endpoint_drift", input.endpointDriftEvents, 1);
  appendCount("pipeline_publication_divergence", input.publicationDivergences, 1);
  return alerts;
}
