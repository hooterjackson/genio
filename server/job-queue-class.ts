import { PUBLIC_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";

/**
 * Durable queue classes are a security boundary, not merely a scheduling
 * hint. Deep workers can perform evidence research and read-only catalog
 * resolution, but they must never receive user-token-backed Apple writes,
 * notifications, or system-maintenance jobs.
 */
export const JOB_QUEUE_CLASSES = ["interactive", "deep", "publication", "system"] as const;
export type JobQueueClass = typeof JOB_QUEUE_CLASSES[number];

export const WORKER_QUEUE_CLASSES = ["interactive", "deep", "all"] as const;
export type WorkerQueueClass = typeof WORKER_QUEUE_CLASSES[number];

const SYSTEM_JOB_KINDS = new Set([
  "notification",
  "apple_authorization",
  "retention",
  "pipeline_observability",
]);

export function isJobQueueClass(value: unknown): value is JobQueueClass {
  return typeof value === "string" && (JOB_QUEUE_CLASSES as readonly string[]).includes(value);
}

export function parseWorkerQueueClass(value: unknown, fallback: WorkerQueueClass = "interactive"): WorkerQueueClass {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (WORKER_QUEUE_CLASSES as readonly string[]).includes(value)) {
    return value as WorkerQueueClass;
  }
  throw new Error(`WORKER_QUEUE_CLASS must be one of ${WORKER_QUEUE_CLASSES.join(", ")}`);
}

export function queueClassesForWorker(queueClass: WorkerQueueClass): readonly JobQueueClass[] {
  switch (queueClass) {
    case "deep": return ["deep"];
    case "interactive": return ["publication", "interactive", "system"];
    case "all": return JOB_QUEUE_CLASSES;
  }
}

export function defaultJobQueueClass(input: {
  kind: string;
  requested?: JobQueueClass;
  payload?: Record<string, unknown>;
}): JobQueueClass {
  if (input.kind === "publication") return "publication";
  if (SYSTEM_JOB_KINDS.has(input.kind)) return "system";
  if (input.requested) {
    if (!isJobQueueClass(input.requested)) throw new Error("Job queue class is invalid");
    if (input.requested === "publication" || input.requested === "system") {
      throw new Error(`Job kind ${input.kind} cannot enter the ${input.requested} queue`);
    }
    return input.requested;
  }
  return "interactive";
}

export function isColdCorpusWork(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.workloadClass === "cold_corpus";
}

export function isDeepQueryPlan(plan: unknown): boolean {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  const record = plan as Record<string, unknown>;
  const engines = Array.isArray(record.engines)
    ? record.engines.filter((value): value is string => typeof value === "string")
    : typeof record.engine === "string" ? [record.engine] : [];
  const targetTrackCount = record.targetTrackCount;
  const expandedCount = Number.isSafeInteger(targetTrackCount)
    && Number(targetTrackCount) > PUBLIC_PLAYLIST_MAXIMUM_TRACKS;
  return expandedCount
    || engines.includes("factual_relationship")
    || engines.includes("exhaustive");
}
