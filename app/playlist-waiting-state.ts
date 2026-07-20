export type PlaylistWorkStage = "plan" | "discover" | "verify" | "match" | "sequence" | "publish";
export type PlaylistWorkMotion = "active" | "action-required" | "paused" | "idle";

type WaitingRun = {
  status: string;
  phase?: string | null;
  autoPublish?: boolean;
};

const terminalStatuses = new Set([
  "complete",
  "partial",
  "failed",
  "no_compatible_tracks",
  "cancelled",
  "failed_system",
  "failed_integrity",
  "expired",
  "deleted",
]);
const actionRequiredStatuses = new Set([
  "awaiting_guidance",
  "partial_ready",
]);
const pausedStatuses = new Set([
  "awaiting_budget",
  "waiting_for_apple_authorization",
  "waiting_for_corpus_review",
]);

const publishSignals = [
  "publish",
  "publication",
  "apple_authorization",
  "apple_reauthorization",
  "share_link",
];

const sequenceSignals = [
  "sequence",
  "sequencing",
  "manifest",
  "selection",
];

const matchingSignals = [
  "matching",
  "catalog_match",
  "research_complete",
  "visitor_review",
  "exception_review",
  "ready_for_matching",
];

const verificationSignals = [
  "verify",
  "verification",
  "claim",
  "evidence",
  "gap_analysis",
  "scope_qual",
];

const discoverySignals = [
  "research",
  "discover",
  "enumerat",
  "source",
  "container",
  "catalog_refill",
];

export function isAutomaticPlaylistHandoff(run: WaitingRun): boolean {
  return run.autoPublish === true
    && (run.status === "visitor_review" || run.status === "manifest_ready");
}

export function playlistWorkMotion(run: WaitingRun): PlaylistWorkMotion {
  if (terminalStatuses.has(run.status)) return "idle";
  if (actionRequiredStatuses.has(run.status)) return "action-required";
  if (pausedStatuses.has(run.status)) return "paused";
  return "active";
}

/**
 * Maps durable backend phases to an honest, human-readable macro stage.
 * Ordering matters: `catalog_refill_research`, for example, is discovery work
 * even though it contains the word "catalog".
 */
export function playlistWorkStage(run: WaitingRun): PlaylistWorkStage {
  if (isAutomaticPlaylistHandoff(run)) return "sequence";
  if (run.status === "awaiting_guidance") return "plan";
  if (run.status === "partial_ready") return "sequence";
  if (run.status === "resolving_catalog") return "match";
  if (run.status === "continuing_research") return "discover";
  const signal = `${run.status} ${run.phase ?? ""}`.toLowerCase();
  if (publishSignals.some((value) => signal.includes(value))) return "publish";
  if (sequenceSignals.some((value) => signal.includes(value))) return "sequence";
  if (signal.includes("catalog_refill_research")) return "discover";
  if (matchingSignals.some((value) => signal.includes(value))) return "match";
  if (verificationSignals.some((value) => signal.includes(value))) return "verify";
  if (run.status === "queued" || signal.includes("queue") || signal.includes("brief")) return "plan";
  if (discoverySignals.some((value) => signal.includes(value))) return "discover";
  return "discover";
}

export function playlistWorkState(run: WaitingRun): {
  stage: PlaylistWorkStage;
  motion: PlaylistWorkMotion;
} {
  return {
    stage: playlistWorkStage(run),
    motion: playlistWorkMotion(run),
  };
}
