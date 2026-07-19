export type PlaylistWorkStage = "queue" | "research" | "match" | "build";
export type PlaylistWorkMotion = "active" | "paused" | "idle";

type WaitingRun = {
  status: string;
  phase?: string | null;
};

const terminalStatuses = new Set(["complete", "partial", "failed", "expired", "deleted"]);
const pausedStatuses = new Set(["awaiting_budget", "waiting_for_apple_authorization"]);

const buildSignals = [
  "manifest",
  "publish",
  "publication",
  "apple_authorization",
  "apple_reauthorization",
  "share_link",
];

const matchingSignals = [
  "matching",
  "catalog_match",
  "catalog_refill",
  "research_complete",
  "visitor_review",
  "exception_review",
  "ready_for_matching",
];

export function playlistWorkMotion(run: WaitingRun): PlaylistWorkMotion {
  if (terminalStatuses.has(run.status)) return "idle";
  if (pausedStatuses.has(run.status)) return "paused";
  return "active";
}

export function playlistWorkStage(run: WaitingRun): PlaylistWorkStage {
  const signal = `${run.status} ${run.phase ?? ""}`.toLowerCase();
  if (buildSignals.some((value) => signal.includes(value))) return "build";
  if (matchingSignals.some((value) => signal.includes(value))) return "match";
  if (run.status === "queued" || signal.includes("queue")) return "queue";
  return "research";
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

