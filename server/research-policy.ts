import type { PlaylistBrief } from "../shared/types.ts";
import { stableStringify } from "./security.ts";

type Environment = Record<string, string | undefined>;

export interface FastResearchPolicy {
  kind: "fast_curated";
  version: "fast_curated_v1";
  model: string;
  runDeadlineMs: number;
  matchingReserveMs: number;
  candidateLimit: number;
  maxWebToolCalls: number;
  maxSynthesisTokens: number;
  maxExtractionTokens: number;
  searchContextSize: "low" | "medium";
}

export interface DeepResearchPolicy {
  kind: "deep";
  version: "deep_v1";
  model: string;
}

export type ResearchExecutionPolicy = FastResearchPolicy | DeepResearchPolicy;

export const FAST_RUN_DEADLINE_MS = 120_000;
export const FAST_MATCHING_RESERVE_MS = 25_000;
export const FAST_MATCHING_FINALIZATION_RESERVE_MS = 5_000;

export interface FastRouteCheckpoint {
  status: "queued";
  profile: FastResearchPolicy["version"];
  model: string;
  confirmedAt: string;
  researchDeadlineAt: string;
  deadlineAt: string;
  matchingReserveMs: number;
}

export function createFastRouteCheckpoint(
  policy: FastResearchPolicy,
  confirmedAt = new Date(),
): FastRouteCheckpoint {
  const confirmedMs = confirmedAt.getTime();
  if (!Number.isFinite(confirmedMs)) throw new Error("Fast-run confirmation time is invalid");
  const deadlineMs = confirmedMs + policy.runDeadlineMs;
  return {
    status: "queued",
    profile: policy.version,
    model: policy.model,
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(deadlineMs - policy.matchingReserveMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: policy.matchingReserveMs,
  };
}

export function parseFastRouteCheckpoint(
  value: unknown,
  expectedVersion: FastResearchPolicy["version"] = "fast_curated_v1",
): FastRouteCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<FastRouteCheckpoint>;
  if (row.status !== "queued" || row.profile !== expectedVersion || typeof row.model !== "string") return null;
  const confirmedMs = typeof row.confirmedAt === "string" ? Date.parse(row.confirmedAt) : Number.NaN;
  const researchDeadlineMs = typeof row.researchDeadlineAt === "string" ? Date.parse(row.researchDeadlineAt) : Number.NaN;
  const deadlineMs = typeof row.deadlineAt === "string" ? Date.parse(row.deadlineAt) : Number.NaN;
  if (!Number.isFinite(confirmedMs) || !Number.isFinite(researchDeadlineMs) || !Number.isFinite(deadlineMs)) return null;
  if (deadlineMs - confirmedMs !== FAST_RUN_DEADLINE_MS) return null;
  if (researchDeadlineMs <= confirmedMs || researchDeadlineMs >= deadlineMs) return null;
  if (row.matchingReserveMs !== deadlineMs - researchDeadlineMs
    || row.matchingReserveMs !== FAST_MATCHING_RESERVE_MS) return null;
  return {
    status: "queued",
    profile: expectedVersion,
    model: row.model,
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(researchDeadlineMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: row.matchingReserveMs,
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function fastResearchModel(environment: Environment = process.env): string {
  return environment.OPENAI_FAST_MODEL?.trim() || "gpt-5.6-luna";
}

export function deepResearchModel(environment: Environment = process.env): string {
  return environment.OPENAI_DEEP_MODEL?.trim()
    || environment.OPENAI_MODEL?.trim()
    || "gpt-5.6-terra";
}

export function briefInterpretationModel(environment: Environment = process.env): string {
  return environment.OPENAI_BRIEF_MODEL?.trim() || fastResearchModel(environment);
}

/**
 * Curated prompts are intentionally time-boxed. They produce a cited editorial
 * selection, not a claim of exhaustive source-frontier completion. Factual
 * exhaustive and constrained-hybrid prompts retain the durable deep pipeline.
 */
export function researchExecutionPolicy(
  brief: Pick<PlaylistBrief, "mode" | "targetSize">,
  environment: Environment = process.env,
): ResearchExecutionPolicy {
  if (brief.mode !== "curated") {
    return { kind: "deep", version: "deep_v1", model: deepResearchModel(environment) };
  }

  const targetMaximum = Math.max(50, Math.min(100, Math.floor(brief.targetSize?.max ?? 100)));

  return {
    kind: "fast_curated",
    version: "fast_curated_v1",
    model: fastResearchModel(environment),
    // One immutable wall-clock budget begins when the run is confirmed. The
    // research cutoff leaves a fixed tail for Apple catalog matching; phases
    // never start independent countdowns.
    runDeadlineMs: FAST_RUN_DEADLINE_MS,
    matchingReserveMs: FAST_MATCHING_RESERVE_MS,
    candidateLimit: Math.min(120, Math.ceil(targetMaximum * 1.2)),
    maxWebToolCalls: boundedInteger(environment.FAST_RESEARCH_MAX_WEB_CALLS, 5, 1, 6),
    maxSynthesisTokens: boundedInteger(environment.FAST_RESEARCH_MAX_SYNTHESIS_TOKENS, 6_000, 2_000, 8_000),
    maxExtractionTokens: boundedInteger(environment.FAST_RESEARCH_MAX_EXTRACTION_TOKENS, 8_000, 2_000, 12_000),
    searchContextSize: environment.FAST_RESEARCH_SEARCH_CONTEXT === "medium" ? "medium" : "low",
  };
}

export function researchPolicyFingerprint(
  brief: Pick<PlaylistBrief, "mode" | "targetSize">,
  environment: Environment = process.env,
): string {
  const policy = researchExecutionPolicy(brief, environment);
  // Spread the complete effective policy so newly introduced execution knobs
  // cannot silently reuse results produced under an older configuration.
  return stableStringify({ fingerprintVersion: 2, ...policy });
}
