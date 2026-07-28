"use client";

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PUBLIC_PLAYLIST_DEFAULT_TRACKS,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";
import {
  fastRunWindowLabel,
  fastRunWindowPhrase,
} from "../shared/fast-run-sla.ts";
import type {
  RunDecisionActionView,
  RunGuidanceActionView,
  RunProgressView,
} from "../shared/types.ts";
import { BrandIntro } from "./brand-intro";
import { type PrimaryNavItem } from "./primary-nav";
import { PublicSiteHeader } from "./public-site-header";
import { isAutomaticPlaylistHandoff, playlistWorkState } from "./playlist-waiting-state";
import { WorkingIndicator } from "./working-indicator";
import {
  actionRequiredJobLabel,
  apiErrorCode,
  evidenceCountSummary,
  partialDecisionHeading,
  partialDecisionSummary,
  partialReadyView,
  publishedTrackCountSummary,
  publishedResultHeading,
  runResolutionControls,
  shouldKeepPollingBlockedRun,
  shouldPresentShortfallWithoutError,
  shouldQuietlyClearInitialRunRestore,
  type PartialPublicationAction,
  type PartialReadyView,
} from "./playlist-builder-ui-policy";

type PlaylistMode = "exhaustive" | "curated" | "hybrid";

type PlaylistBrief = {
  title: string;
  description: string;
  mode: PlaylistMode;
  subjectEntities: string[];
  relationship: string;
  include: string[];
  exclude: string[];
  versionPolicy: string;
  evidencePolicy: string;
  orderingPolicy?: string;
  targetSize: { min: number; max: number } | null;
  ambiguities: string[];
  ambiguityAcceptance?: string[];
};

type PlaylistCommandSubmission = {
  prompt: string;
  trackCount: string;
};

type FrontierItem = {
  sourceClass: string;
  strategy: string;
  status: "pending" | "complete" | "inaccessible" | "unresolved";
  discoveredCount: number;
  recoveredCount: number;
  note?: string;
};

type ResearchRun = {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: string;
  phase: string;
  autoPublish?: boolean;
  error?: string | null;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  frontier: FrontierItem[];
  pipelineVersion?: string;
  policyVersion?: string;
  selectionPlan?: {
    requestedTrackCount?: number;
    reserveTrackCount?: number;
    intents?: string[];
    storefront?: string;
  } | null;
  pipelineOutcome?: {
    status?: string;
    targetTrackCount?: number;
    qualifiedTrackCount?: number;
    selectedTrackCount?: number;
    publishedTrackCount?: number;
    reasonCodes?: string[];
  } | null;
  actionRequired?: PartialPublicationAction | null;
  partialAction?: PartialPublicationAction | null;
  decisionAction?: RunDecisionActionView | null;
  guidanceAction?: RunGuidanceActionView | null;
  candidateStageCounts?: Partial<Record<string, number>>;
  progress?: RunProgressView;
  resolution?: {
    state: "accepted" | "needs_input" | "probing" | "executing" | "blocked_dependency" | "needs_decision" | "ready" | "publishing" | "completed" | "cancelled" | "quarantined";
    nextAction: "none" | "answer_initial_guidance" | "answer_rescue_guidance" | "wait_for_dependency" | "resume_research" | "authorize_apple" | "decide_verified_partial" | "review_contract" | "contact_support";
    terminal: boolean;
    contractRevisionId: string | null;
    contractRevision: number | null;
    contractHash: string | null;
    blocker: {
      kind: string;
      nextRetryAt: string | null;
      automaticRetryUntil: string | null;
      retryCount: number;
      versionHash: string | null;
    } | null;
  };
  createdAt?: string;
  updatedAt?: string;
};

type CatalogSong = {
  id: string;
  name: string;
  artistName: string;
  albumName?: string;
  releaseDate?: string;
  durationInMillis?: number;
  isrc?: string;
};

type SelectableTrack = {
  position: number;
  candidateId: string;
  selectionRank: number | null;
  artist: string;
  title: string;
  album?: string | null;
  releaseYear?: number | null;
  durationMs?: number | null;
  isrc?: string | null;
  versionLabel?: string | null;
  duplicateClusterKey?: string | null;
  status: string;
  basis?: string | null;
  score?: number;
  catalogId?: string | null;
  song?: CatalogSong | null;
  alternatives: CatalogSong[];
  evidenceEligible: boolean;
  selected: boolean;
  selectable: boolean;
  retryable?: boolean;
};

type TrackSelection = {
  items: SelectableTrack[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  selectableCount: number;
  unmatchedCount: number;
  retryableCount: number;
  matchingComplete: boolean;
  requestedTrackCount: number | null;
};

type TrackSelectionRequest =
  | { selected: Array<{ candidateId: string; catalogId: string }> }
  | {
      useRecommended: true;
      excludedCandidateIds: string[];
      overrides: Array<{ candidateId: string; catalogId: string }>;
    };

type ManifestTrack = {
  candidateId: string;
  catalogId: string;
  artist: string;
  title: string;
};

type PlaylistManifest = {
  id: string;
  runId: string;
  name: string;
  description?: string;
  contentHash?: string;
  volumeCount?: number;
  trackCount?: number;
  tracks: ManifestTrack[];
};

type PublishedVolume = {
  index: number;
  name: string;
  url?: string | null;
  trackCount: number;
  status?: string;
};

type RunResult = {
  runId: string;
  title?: string;
  status: string;
  volumes: PublishedVolume[];
  requestedTrackCount?: number | null;
  outcomeCounts?: Record<string, number>;
  sourceCount?: number;
  unresolvedGapCount?: number;
  evidenceUrl?: string | null;
  coverageSummary?: string;
  explore?: {
    eligible: boolean;
    listed: boolean;
    canChange: boolean;
    reason?: string | null;
  } | null;
};

type BriefResponse = {
  brief?: PlaylistBrief;
  prompt?: string;
  requestedTrackCount?: number | null;
  cached?: boolean;
  requestId?: string;
  status?: string;
  pollAfterMs?: number;
  questions?: GuidedQuestion[];
  briefContractVersion?: 1 | 2 | 3;
  questionSetHash?: string | null;
  error?: string;
};

type GuidedQuestionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  feasibility?: "broad" | "moderate" | "narrow";
};

type GuidedQuestionGrounding = {
  summary?: string;
  sourceUrls?: string[];
};

type GuidedQuestion = {
  id: string;
  header?: string;
  question: string;
  whyMaterial?: string;
  grounding?: GuidedQuestionGrounding;
  criticality?: "required" | "optional";
  selectionMode?: "single" | "multiple";
  allowCustom?: boolean;
  interpretationSummary?: {
    mustHave: readonly string[];
    prefer: readonly string[];
    avoid: readonly string[];
    flow: readonly string[];
    count: number;
  };
  options: GuidedQuestionOption[];
};

function guidanceSourceLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./u, "");
  } catch {
    return "source";
  }
}

type GuidedAnswer = {
  questionId: string;
  optionId?: string;
  optionIds?: string[];
  customText?: string;
  skipped?: boolean;
};

type GuidanceHistoryItem = {
  answerSetId: string;
  questionSetHash: string;
  question: {
    id: string;
    header: string;
    question: string;
    criticality: "required" | "optional";
    selectionMode: "single" | "multiple";
    allowCustom: boolean;
    options: GuidedQuestionOption[];
  };
  selectedOptionIds: string[];
  selectedOptionLabels: string[];
  hadCustomAnswer: boolean;
  skipped: boolean;
  axis: string | null;
  trigger: "correctness" | "yield_risk" | "nuance";
  acceptedAt: string;
};

type GuidanceHistoryView = {
  activeContractRevisionId: string;
  activeContractSemanticHash: string;
  historyVersion: string;
  items: GuidanceHistoryItem[];
};

type GuidanceRevisionConfirmation = {
  item: GuidanceHistoryItem;
  answer: GuidedAnswer;
  confirmationHash: string;
  interpretationSummary: {
    mustHave: readonly string[];
    prefer: readonly string[];
    avoid: readonly string[];
    flow: readonly string[];
    count: number;
  };
  hardChangeReasons: string[];
};

type RunResponse = {
  run?: ResearchRun;
  capability?: string;
  capabilityToken?: string;
};

type JsonObject = Record<string, unknown>;

const examples = [
  "Paulinho da Costa’s most influential recordings",
  "Tracks that shaped Berlin techno",
  "Songs built around the Amen break",
];

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
const reviewStatuses = new Set(["review", "visitor_review"]);
class ApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class BriefInterpretationError extends Error {}
type GuidanceRecoveryMode =
  | "configuration"
  | "edit_artist"
  | "retry_lookup";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extractError(payload: unknown, status: number): string {
  const object = asObject(payload);
  if (typeof object.error === "string") return object.error;
  if (typeof object.message === "string") return object.message;
  const nested = asObject(object.error);
  if (typeof nested.message === "string") return nested.message;
  return "Request failed (" + status + ")";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");

  if (!response.ok) {
    throw new ApiError(extractError(payload, response.status), response.status, apiErrorCode(payload));
  }
  return payload as T;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function waitForBrief(requestId: string, initialDelayMs = 1_500, signal?: AbortSignal): Promise<BriefResponse> {
  let delayMs = Math.max(500, Math.min(initialDelayMs, 5_000));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await abortableDelay(delayMs, signal);
    const response = await api<BriefResponse>("/api/v1/brief/" + encodeURIComponent(requestId), { signal });
    if (response.status === "failed") throw new BriefInterpretationError(response.error || "Scope interpretation failed.");
    if (response.status === "awaiting_answers" && response.questions?.length) return response;
    if (response.brief && (!response.status || response.status === "complete")) return response;
    if (attempt >= 15) delayMs = 5_000;
  }
  throw new Error("Your playlist request is still being prepared. Reload this private request URL to continue.");
}

function unwrapRun(payload: ResearchRun | RunResponse): ResearchRun {
  const object = asObject(payload);
  return (object.run ?? payload) as ResearchRun;
}

function unwrapManifest(payload: PlaylistManifest | { manifest: PlaylistManifest }): PlaylistManifest {
  const object = asObject(payload);
  return (object.manifest ?? payload) as PlaylistManifest;
}

function resultExploreSettings(...values: unknown[]): RunResult["explore"] {
  for (const value of values) {
    const object = asObject(value);
    if (Object.keys(object).length === 0) continue;
    if (typeof object.eligible !== "boolean" || typeof object.listed !== "boolean") continue;
    return {
      eligible: object.eligible,
      listed: object.listed,
      canChange: typeof object.canChange === "boolean" ? object.canChange : true,
      reason: typeof object.reason === "string" ? object.reason : null,
    };
  }
  return null;
}

function unwrapResult(
  payload: RunResult | { result: RunResult } | JsonObject,
  currentRun?: ResearchRun | null,
): RunResult {
  const object = asObject(payload);
  if (object.publication || object.run) {
    const run = asObject(object.run);
    const publication = asObject(object.publication);
    const rawVolumes = Array.isArray(publication.volumes) ? publication.volumes : [];
    const runId = typeof run.id === "string" ? run.id : "";
    const resultBrief = Object.keys(asObject(run.brief)).length > 0
      ? asObject(run.brief) as PlaylistBrief
      : currentRun?.brief;
    return {
      runId,
      title: typeof asObject(run.brief).title === "string" ? asObject(run.brief).title as string : undefined,
      status: typeof publication.status === "string"
        ? publication.status
        : typeof run.status === "string"
          ? run.status
          : "complete",
      volumes: rawVolumes.map((raw, index) => {
        const volume = asObject(raw);
        const start = numberValue(volume.startPosition);
        const end = numberValue(volume.endPosition, start + numberValue(volume.appendedCount) - 1);
        return {
          index: index + 1,
          name: typeof volume.name === "string" ? volume.name : "gênio volume " + (index + 1),
          url: appleMusicUrl(volume.shareUrl),
          trackCount: Math.max(0, end - start + 1) || numberValue(volume.appendedCount),
          status: typeof volume.status === "string" ? volume.status : undefined,
        };
      }),
      requestedTrackCount: resultBrief ? exactRequestedTrackCount(resultBrief) : null,
      outcomeCounts: asObject(object.outcomes) as Record<string, number>,
      sourceCount: numberValue(run.sourceCount),
      unresolvedGapCount: numberValue(run.unresolvedCount),
      evidenceUrl: runId ? "/api/v1/runs/" + encodeURIComponent(runId) + "/evidence" : null,
      coverageSummary: "Published from " + numberValue(run.sourceCount) + " documented sources with " + numberValue(run.unresolvedCount) + " visible gaps.",
      explore: resultExploreSettings(object.explore, run.explore),
    };
  }
  const directVolumeRows = Array.isArray(object.volumes) ? object.volumes : null;
  const directVolumes = directVolumeRows
    && directVolumeRows.every((raw) => {
      const volume = asObject(raw);
      return typeof volume.trackCount === "number"
        && typeof volume.name === "string";
    });
  if (directVolumes && directVolumeRows) {
    const runId = typeof object.runId === "string" ? object.runId : currentRun?.id ?? "";
    const sourceCount = numberValue(object.sourceCount, numberValue(currentRun?.sourceCount));
    const unresolvedGapCount = numberValue(
      object.unresolvedGapCount,
      numberValue(currentRun?.unresolvedCount),
    );
    return {
      runId,
      title: typeof object.title === "string" ? object.title : currentRun?.brief.title,
      status: typeof object.status === "string" ? object.status : currentRun?.status ?? "complete",
      volumes: directVolumeRows.map((raw, index) => {
        const volume = asObject(raw);
        return {
          index: numberValue(volume.index, index + 1),
          name: typeof volume.name === "string" ? volume.name : "gênio volume " + (index + 1),
          url: appleMusicUrl(volume.url),
          trackCount: numberValue(volume.trackCount),
          status: typeof volume.status === "string" ? volume.status : undefined,
        };
      }),
      requestedTrackCount: typeof object.requestedTrackCount === "number"
        ? object.requestedTrackCount
        : currentRun
          ? exactRequestedTrackCount(currentRun.brief)
          : null,
      outcomeCounts: asObject(object.outcomeCounts ?? object.outcomes) as Record<string, number>,
      sourceCount,
      unresolvedGapCount,
      evidenceUrl: typeof object.evidenceUrl === "string"
        ? object.evidenceUrl
        : runId
          ? "/api/v1/runs/" + encodeURIComponent(runId) + "/evidence"
          : null,
      coverageSummary: typeof object.coverageSummary === "string"
        ? object.coverageSummary
        : "Published from " + sourceCount + " documented sources with " + unresolvedGapCount + " visible gaps.",
      explore: resultExploreSettings(object.explore),
    };
  }
  if (Array.isArray(object.volumes)) {
    const manifest = asObject(object.manifest);
    const rawVolumes = object.volumes;
    const manifestName = typeof manifest.name === "string" ? manifest.name : currentRun?.brief.title ?? "gênio playlist";
    const volumeCount = rawVolumes.length;
    return {
      runId: currentRun?.id ?? "",
      title: manifestName,
      status: currentRun?.status ?? "complete",
      volumes: rawVolumes.map((raw, index) => {
        const volume = asObject(raw);
        const start = numberValue(volume.startPosition ?? volume.start_position);
        const end = numberValue(volume.endPosition ?? volume.end_position, start);
        const ordinal = numberValue(volume.volumeNumber ?? volume.volume_number, index + 1);
        const total = numberValue(volume.volumeCount ?? volume.volume_count, volumeCount);
        return {
          index: ordinal,
          name: total > 1 ? manifestName + " [" + ordinal + "/" + total + "]" : manifestName,
          url: appleMusicUrl(volume.appleShareUrl ?? volume.shareUrl),
          trackCount: Math.max(0, end - start + 1) || numberValue(volume.appendedCount ?? volume.appended_count),
          status: typeof volume.status === "string" ? volume.status : undefined,
        };
      }),
      requestedTrackCount: currentRun ? exactRequestedTrackCount(currentRun.brief) : null,
      outcomeCounts: asObject(object.outcomeCounts ?? object.outcomes) as Record<string, number>,
      sourceCount: numberValue(currentRun?.sourceCount),
      unresolvedGapCount: numberValue(currentRun?.unresolvedCount),
      evidenceUrl: currentRun?.id
        ? "/api/v1/runs/" + encodeURIComponent(currentRun.id) + "/evidence"
        : null,
      coverageSummary: "Published from " + numberValue(currentRun?.sourceCount) + " documented sources with " + numberValue(currentRun?.unresolvedCount) + " visible gaps.",
      explore: resultExploreSettings(object.explore),
    };
  }
  return (object.result ?? payload) as RunResult;
}

function manifestFromResult(payload: unknown, runId: string): PlaylistManifest | null {
  const object = asObject(payload);
  const manifest = asObject(object.manifest);
  if (typeof manifest.id !== "string") return null;
  return {
    id: manifest.id,
    runId,
    name: typeof manifest.name === "string" ? manifest.name : "gênio playlist",
    contentHash: typeof manifest.contentHash === "string" ? manifest.contentHash : undefined,
    trackCount: numberValue(manifest.trackCount),
    tracks: [],
  };
}

function normalizeTrackSelection(payload: unknown, requestedPage: number): TrackSelection {
  const object = asObject(payload);
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(object.items)
      ? object.items
      : [];
  const items = rawItems as SelectableTrack[];
  const pageSize = numberValue(object.pageSize, 200);
  const total = numberValue(object.total, items.length);
  const page = numberValue(object.page, requestedPage);
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: numberValue(object.totalPages, Math.max(1, Math.ceil(total / pageSize))),
    selectableCount: numberValue(object.selectableCount, items.filter((item) => item.selectable).length),
    unmatchedCount: numberValue(object.unmatchedCount, items.filter((item) => !item.selectable).length),
    retryableCount: numberValue(object.retryableCount),
    matchingComplete: object.matchingComplete !== false,
    requestedTrackCount: typeof object.requestedTrackCount === "number"
      ? Math.max(1, Math.floor(object.requestedTrackCount))
      : null,
  };
}

function exactRequestedTrackCount(brief: PlaylistBrief): number | null {
  if (brief.mode !== "curated" || !brief.targetSize) return null;
  const minimum = Number(brief.targetSize.min);
  const maximum = Number(brief.targetSize.max);
  return Number.isInteger(minimum) && Number.isInteger(maximum) && minimum === maximum
    ? Math.max(1, maximum)
    : null;
}

function assertExactBriefTrackCount(brief: PlaylistBrief, requestedTrackCount: number): void {
  if (exactRequestedTrackCount(brief) !== requestedTrackCount) {
    throw new Error(
      `The playlist size changed while preparing the request. Expected ${requestedTrackCount.toLocaleString()} tracks; please retry.`,
    );
  }
}

function trackChoices(item: SelectableTrack, limit = 12): CatalogSong[] {
  const seen = new Set<string>();
  const choices: CatalogSong[] = [];
  for (const song of [item.song, ...(Array.isArray(item.alternatives) ? item.alternatives : [])]) {
    if (!song || typeof song.id !== "string" || seen.has(song.id)) continue;
    seen.add(song.id);
    choices.push(song);
    if (choices.length >= limit) break;
  }
  return choices;
}

function recommendedCatalogId(item: SelectableTrack): string | null {
  return item.catalogId ?? item.song?.id ?? null;
}

function recommendedByDefault(item: SelectableTrack): boolean {
  return item.selectable
    && Boolean(recommendedCatalogId(item))
    && (item.status === "accepted" || item.status === "review");
}

const RETRYABLE_APPLE_MATCH_BASES = new Set([
  "Apple catalog lookup did not complete inside the absolute fast-run window",
  "Apple catalog lookup did not complete inside the fast matching window",
  "Apple catalog was temporarily unavailable during fast matching",
]);

const FAILED_APPLE_MATCH_BASIS =
  "Apple catalog recovery could not resolve this track after retry attempts";

type TrackReviewState = "matched" | "choose-match" | "needs-match" | "match-failed" | "unavailable" | "excluded";

function trackReviewLabel(state: TrackReviewState): string {
  switch (state) {
    case "choose-match": return "CHOOSE VERSION";
    case "needs-match": return "NEEDS MATCH";
    case "match-failed": return "MATCH FAILED";
    case "unavailable": return "UNAVAILABLE";
    case "excluded": return "EXCLUDED";
    default: return "MATCHED";
  }
}

function trackCountLabel(count: number): string {
  return `${count.toLocaleString()} track${count === 1 ? "" : "s"}`;
}

function unavailableTrackCountLabel(count: number): string {
  return `${count.toLocaleString()} unavailable track${count === 1 ? "" : "s"}`;
}

function isAbortError(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "name" in value && value.name === "AbortError");
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function appleMusicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "music.apple.com" || !/\/playlist\//i.test(url.pathname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for local and embedded browsers without clipboard grants.
    }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "true");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("The transfer link could not be copied in this browser.");
}

function phaseMessage(run: ResearchRun): string {
  if (run.phase === "dependency_resume_scheduled") {
    return "You authorized another exact-contract attempt. It will run when the dependency and matching executor are available.";
  }
  if (run.phase === "public_rollout_successor_required") {
    return "Your confirmed interpretation moved outside its signed test cohort. Nothing was weakened or executed.";
  }
  if (run.phase === "contract_execution_paused") {
    return "Execution is disabled for this signed cohort. Nothing was researched or published; revise the saved request or cancel it.";
  }
  if (run.resolution?.state === "blocked_dependency") {
    if (run.status === "waiting_for_apple_authorization"
      || run.resolution.blocker?.kind === "apple_authorization") {
      return "Your verified playlist is saved while Apple Music authorization is restored.";
    }
    const retryAt = run.resolution.blocker?.nextRetryAt;
    return retryAt
      ? `Research is safely paused for a dependency and will retry after ${new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
      : "Research is safely paused for a dependency. Your progress remains saved.";
  }
  if (run.resolution?.state === "needs_input") {
    return run.resolution.nextAction === "answer_rescue_guidance"
      ? "A focused scope decision is needed to finish this playlist without weakening its quality."
      : "Your answer is needed before research can continue.";
  }
  if (run.resolution?.state === "needs_decision") {
    return "Research reached a safe boundary. Review the verified result and choose how to continue.";
  }
  if (run.resolution?.state === "quarantined") {
    return "A technical integrity safeguard paused this job before anything unsafe could be published.";
  }
  if (run.status === "awaiting_guidance") return "Your answer is needed before research can continue.";
  if (run.status === "partial_ready") return "Choose whether to continue researching or publish the verified tracks.";
  if (run.status === "awaiting_budget") return "Paused for owner budget approval.";
  if (run.status === "waiting_for_apple_authorization") return "Paused until the owner reconnects Apple Music.";
  if (run.status === "waiting_for_corpus_review") {
    return "Paused until the owner reviews and activates the evidence corpus required by this request.";
  }
  if (["failed", "failed_system", "failed_integrity"].includes(run.status)) {
    return run.error || "Research stopped before a safe playlist could be prepared.";
  }
  if (run.status === "no_compatible_tracks") return "Research reached the current evidence frontier and needs a scope decision.";
  if (run.status === "cancelled") return "This playlist job was cancelled.";
  const requestedTracks = run.brief.targetSize?.min ?? PUBLIC_PLAYLIST_DEFAULT_TRACKS;
  const windowPhrase = fastRunWindowPhrase(requestedTracks);
  const phase = run.phase.toLowerCase();
  if (run.status === "queued") return run.brief.mode === "curated"
    ? `Queued. The ${windowPhrase} research window includes queue time.`
    : "Waiting for an available research slot.";
  if (isAutomaticPlaylistHandoff(run)) {
    return "Locking the selected recording versions into the final playlist order before publication.";
  }
  if (run.status === "publishing" || phase.includes("publication")) return "Creating the public Apple Music playlist and verifying its final order.";
  if (phase.includes("sequence")) return "Spacing artists, albums, eras, and scenes into a coherent listening order.";
  if (phase.includes("manifest")) return "Locking the selected recording versions into an ordered playlist manifest.";
  if (phase.includes("catalog_refill_research")) return "Finding additional evidence-backed recordings for the remaining catalog shortfall.";
  if (run.status === "continuing_research") return "Searching the remaining approved strategies for more qualified recordings.";
  if (run.status === "resolving_catalog") return "Resolving qualified recordings to playable versions in the US Apple Music catalog.";
  if (phase.includes("catalog_matching") || run.status === "matching") return "Resolving verified recordings to playable versions in the US Apple Music catalog.";
  if (phase.includes("catalog_enrichment")) return "Checking recording identities, versions, and release families.";
  if (phase.includes("gap_analysis")) return "Checking the source frontier for missing artists, eras, releases, and claims.";
  if (phase.includes("track_verification") || phase.includes("claim_verification")) return "Verifying that each exact recording satisfies the requested relationship and evidence policy.";
  if (phase.includes("container_enumeration")) return "Enumerating tracks from the discovered releases, sessions, and source collections.";
  if (phase.includes("container_discovery")) return "Finding releases, sessions, playlists, and other bounded source collections.";
  if (phase.includes("source_discovery")) return "Finding authoritative editorial, catalog, and specialist sources for this request.";
  if (run.brief.mode === "curated" && run.phase === "fast_research") {
    return `Finding and verifying cited tracks within the ${windowPhrase} window.`;
  }
  return "Discovering source-backed recordings and checking each one against the confirmed scope.";
}

function useRunPolling(
  runId: string | null,
  runStatus: string | null,
  autoPublish: boolean,
  actionRequired: boolean,
  pollWhileBlocked: boolean,
  onRun: (run: ResearchRun) => void,
  onError: (message: string) => void,
) {
  const onRunRef = useRef(onRun);
  const onErrorRef = useRef(onError);

  useEffect(() => { onRunRef.current = onRun; }, [onRun]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!runId) return;
    const automaticHandoff = !actionRequired && autoPublish && Boolean(
      runStatus && (reviewStatuses.has(runStatus) || runStatus === "manifest_ready"),
    );
    if (actionRequired) return;
    if (runStatus && !automaticHandoff && !pollWhileBlocked
      && (terminalStatuses.has(runStatus) || reviewStatuses.has(runStatus) || runStatus === "manifest_ready")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;

    const poll = async () => {
      try {
        const next = unwrapRun(await api<ResearchRun | RunResponse>("/api/v1/runs/" + encodeURIComponent(runId)));
        if (cancelled) return;
        onRunRef.current(next);
        const nextActionRequired = Boolean(partialReadyView(next));
        const nextBlocked = shouldKeepPollingBlockedRun(next);
        const nextAutomaticHandoff = !nextActionRequired && next.autoPublish === true
          && (reviewStatuses.has(next.status) || next.status === "manifest_ready");
        if (nextActionRequired) return;
        if (!nextAutomaticHandoff && !nextBlocked
          && (terminalStatuses.has(next.status) || reviewStatuses.has(next.status) || next.status === "manifest_ready")) return;
        pollCount += 1;
        timer = setTimeout(poll, pollCount < 60 ? 2000 : 5000);
      } catch (caught) {
        if (cancelled) return;
        const error = caught as ApiError;
        if (error.status === 401 || error.status === 404 || error.status === 410) {
          onErrorRef.current(error.message);
          return;
        }
        pollCount += 1;
        timer = setTimeout(poll, pollCount < 60 ? 2000 : 5000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, runStatus, autoPublish, actionRequired, pollWhileBlocked]);
}

function AppHeader({
  transferState,
  onTransfer,
  onHome,
  onJobs,
  active = "create",
}: {
  transferState?: string;
  onTransfer?: () => void;
  onHome: () => void;
  onJobs?: () => void;
  active?: PrimaryNavItem;
}) {
  const action = onTransfer ? {
    label: transferState === "copied" ? "LINK COPIED" : transferState === "busy" ? "CREATING..." : "SHARE JOB",
    onClick: onTransfer,
    disabled: transferState === "busy",
  } : undefined;

  return (
    <PublicSiteHeader active={active} onHome={onHome} onJobs={onJobs} action={action} />
  );
}

function ErrorBar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="error-bar" role="alert">
      <span>[ERROR]</span>
      <p>{message}</p>
      <button onClick={onDismiss} aria-label="Dismiss error">×</button>
    </div>
  );
}

function JobsScreen({
  jobs,
  loading,
  onBack,
  onNew,
  onOpen,
}: {
  jobs: ResearchRun[];
  loading: boolean;
  onBack: () => void;
  onNew: () => void;
  onOpen: (runId: string) => void;
}) {
  return (
    <section className="screen flow-screen jobs-screen" aria-labelledby="jobs-title">
      <div className="flow-body jobs-body">
        <button className="flow-back" type="button" onClick={onBack}>← CREATE</button>
        <h1 id="jobs-title">Your jobs</h1>
        <p>Open or continue a playlist saved in this browser.</p>

        {loading && <div className="loading-line" role="status"><span className="cursor">▋</span>LOADING JOBS</div>}
        {!loading && jobs.length === 0 && <div className="jobs-empty">NO JOBS FOUND</div>}
        {!loading && jobs.length > 0 && (
          <div className="jobs-list">
            {jobs.map((job) => {
              const actionLabel = actionRequiredJobLabel(job);
              const displayStatus = actionLabel ?? statusLabel(job.status).toUpperCase();
              return (
                <button
                  key={job.id}
                  className={actionLabel ? "needs-action" : undefined}
                  onClick={() => onOpen(job.id)}
                  aria-label={`Open ${job.brief.title} — ${displayStatus}`}
                >
                  <span className="job-status">{displayStatus}</span>
                  <strong>{job.brief.title}</strong>
                  <small>{job.candidateCount.toLocaleString()} tracks · {job.brief.mode}</small>
                  <span className="job-open">{actionLabel ? "REVIEW →" : "OPEN →"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="step-footer">
        <button className="action-button step-primary" onClick={onNew}>NEW JOB →</button>
      </div>
    </section>
  );
}

function OneCommandScreen({
  prompt,
  trackCount,
  busy,
  introSettled,
  onPrompt,
  onTrackCount,
  onSubmit,
}: {
  prompt: string;
  trackCount: string;
  busy: string;
  introSettled: boolean;
  onPrompt: (value: string) => void;
  onTrackCount: (value: string) => void;
  onSubmit: (submission: PlaylistCommandSubmission) => void;
}) {
  // The composer is server-rendered, but its controlled fields cannot retain
  // edits made before React has hydrated and attached event handlers. Keep the
  // form inert for that very short window so a fast tap—or an assistive setup
  // that skips the intro—can never have valid input silently replaced by the
  // initial client state.
  // Keep the server render and the first client render inert. Enabling the
  // form from an effect guarantees React's handlers are attached before a
  // browser or assistive tool can edit the controlled fields; a client
  // snapshot that reports `true` during hydration can briefly expose an
  // editable DOM node whose first input event is then lost.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setHydrated(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const [focused, setFocused] = useState(false);
  const [exampleIndex, setExampleIndex] = useState(0);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const countIsDigits = /^[0-9]+$/u.test(trackCount);
  const count = countIsDigits ? Number.parseInt(trackCount, 10) : Number.NaN;
  const customCount = trackCount.length === 0 || ![25, 50, 100].includes(count);
  const validCount = countIsDigits && Number.isInteger(count)
    && count >= PUBLIC_PLAYLIST_MINIMUM_TRACKS
    && count <= PUBLIC_PLAYLIST_MAXIMUM_TRACKS;
  const promptInvalid = prompt.length > 0 && prompt.trim().length < 4;
  const countInvalid = trackCount.length > 0 && !validCount;
  const timeWindow = fastRunWindowLabel(validCount ? count : PUBLIC_PLAYLIST_DEFAULT_TRACKS);
  const promptMessage = promptInvalid
    ? "Describe the playlist in at least 4 characters."
    : "Describe what the playlist should contain.";
  const countMessage = !validCount
    ? `Choose ${PUBLIC_PLAYLIST_MINIMUM_TRACKS}–${PUBLIC_PLAYLIST_MAXIMUM_TRACKS} tracks.`
    : "The selected track count is exact.";
  const interactive = hydrated && introSettled;

  useEffect(() => {
    if (!focused || prompt) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setExampleIndex((current) => (current + 1) % examples.length);
    }, 2_800);
    return () => window.clearInterval(timer);
  }, [focused, prompt]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the submitted DOM values rather than relying only on React state.
    // Mobile browsers can dispatch submit immediately after the final numeric
    // edit; FormData makes the exact value visible in the field authoritative.
    const data = new FormData(event.currentTarget);
    onSubmit({
      prompt: String(data.get("prompt") ?? prompt),
      trackCount: String(data.get("trackCount") ?? trackCount),
    });
  }

  function choosePreset(value: number) {
    // Preserve the DOM draft if a fast mobile edit landed before React's
    // controlled state finished reconciling.
    onPrompt(promptInputRef.current?.value ?? prompt);
    onTrackCount(String(value));
  }

  function chooseCustom() {
    onPrompt(promptInputRef.current?.value ?? prompt);
    onTrackCount("");
    window.requestAnimationFrame(() => customInputRef.current?.focus());
  }

  return (
    <section className="one-command-screen" aria-labelledby="command-title">
      <div className="one-command-body">
        <header className="command-hero">
          <h1 id="command-title">Create a playlist</h1>
          <p className="command-lead">Describe what you want to hear.</p>
          <p>gênio researches the music, finds the tracks, and builds it in Apple Music.</p>
        </header>
        <form className="one-command-form" onSubmit={submit} aria-busy={Boolean(busy) || !interactive}>
          <section className="command-request-section" aria-labelledby="request-step-title">
            <h2 className="sr-only" id="request-step-title">Playlist request</h2>
            <label className="one-command-request" htmlFor="playlist-request">
              <span className="sr-only">PLAYLIST REQUEST</span>
              <textarea
                ref={promptInputRef}
                id="playlist-request"
                name="prompt"
                value={prompt}
                onChange={(event) => onPrompt(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                rows={5}
                maxLength={2000}
                spellCheck
                required
                disabled={Boolean(busy) || !interactive}
                aria-invalid={promptInvalid}
                aria-describedby="playlist-request-note"
                placeholder={focused ? examples[exampleIndex] : "What should the playlist contain?"}
              />
              <small>{prompt.length.toLocaleString()} / 2,000</small>
            </label>
          </section>

          <section className="command-size-section" aria-labelledby="size-step-title">
            <h2 id="size-step-title">CHOOSE PLAYLIST SIZE</h2>
            {!customCount ? (
              <fieldset className="count-presets">
                <legend className="sr-only">Playlist size</legend>
                {[25, 50, 100].map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-label={`${value} tracks`}
                    aria-pressed={count === value}
                    onClick={() => choosePreset(value)}
                    disabled={Boolean(busy) || !interactive}
                  >
                    {value}
                  </button>
                ))}
                <button
                  type="button"
                  className="custom-count-trigger"
                  aria-label="Custom size"
                  aria-pressed={false}
                  onClick={chooseCustom}
                  disabled={Boolean(busy) || !interactive}
                >
                  Custom
                </button>
              </fieldset>
            ) : (
              <div className="custom-count-editor">
                <label htmlFor="playlist-track-count">
                  <span>EXACT TRACK COUNT</span>
                  <input
                    ref={customInputRef}
                    id="playlist-track-count"
                    name="trackCount"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={trackCount}
                    onChange={(event) => onTrackCount(event.target.value)}
                    required
                    disabled={Boolean(busy) || !interactive}
                    aria-invalid={countInvalid || trackCount.length === 0}
                    aria-describedby="playlist-track-count-note"
                    aria-label="Exact track count"
                    placeholder="1–300"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => choosePreset(PUBLIC_PLAYLIST_DEFAULT_TRACKS)}
                  disabled={Boolean(busy) || !interactive}
                >
                  PRESETS
                </button>
              </div>
            )}
            <div className="count-meta sr-only" aria-live="polite">
              <span>{validCount ? `${count.toLocaleString()} TRACKS` : `LIMIT ${PUBLIC_PLAYLIST_MAXIMUM_TRACKS}`}</span>
              <span>{validCount ? `${timeWindow} TARGET` : `${PUBLIC_PLAYLIST_MINIMUM_TRACKS}–${PUBLIC_PLAYLIST_MAXIMUM_TRACKS} TRACKS`}</span>
            </div>
            {customCount && !validCount && (
              <p className="count-validation" role="alert">
                Enter a whole number from {PUBLIC_PLAYLIST_MINIMUM_TRACKS} to {PUBLIC_PLAYLIST_MAXIMUM_TRACKS}.
              </p>
            )}
          </section>

          <section className="command-create-section" aria-labelledby="create-step-title">
            <h2 className="sr-only" id="create-step-title">Build the playlist</h2>
            <button
              className="one-command-submit"
              type="submit"
              disabled={!interactive || Boolean(busy) || prompt.trim().length < 4 || !validCount}
            >
              {busy
                ? "STARTING..."
                : validCount
                  ? `CREATE PLAYLIST · ${count.toLocaleString()} TRACKS`
                  : "CREATE PLAYLIST"}
            </button>
          </section>
        </form>

        <p className="sr-only" id="playlist-request-note">{promptMessage}</p>
        <p className="sr-only" id="playlist-track-count-note">{countMessage}</p>
      </div>
    </section>
  );
}

function GuidedQuestionScreen({
  questions,
  currentIndex,
  answers,
  busy,
  locked,
  onAnswer,
  onBack,
  onNext,
  onEditArtist,
  recoveryMode = null,
  onChangeEarlierAnswer,
  mode = "initial",
}: {
  questions: GuidedQuestion[];
  currentIndex: number;
  answers: Record<string, GuidedAnswer>;
  busy: boolean;
  locked: boolean;
  onAnswer: (answer: GuidedAnswer) => void;
  onBack: () => void;
  onNext: () => void;
  onEditArtist?: () => void;
  recoveryMode?: GuidanceRecoveryMode | null;
  onChangeEarlierAnswer?: () => void;
  mode?: "initial" | "rescue";
}) {
  const question = questions[currentIndex];
  const titleRef = useRef<HTMLHeadingElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!question) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      titleRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [question]);

  if (!question) return null;
  const currentAnswer = answers[question.id];
  const customSelected = typeof currentAnswer?.customText === "string";
  const customText = currentAnswer?.customText ?? "";
  const orderedOptions = [...question.options]
    .sort((left, right) => Number(right.recommended) - Number(left.recommended))
    .slice(0, 4);
  const validAnswer = Boolean(
    currentAnswer?.optionId
    || currentAnswer?.optionIds?.length
    || customText.trim()
    || currentAnswer?.skipped,
  );
  const lastQuestion = currentIndex === questions.length - 1;
  const groupName = "guidance-" + question.id;
  const progress = ((currentIndex + 1) / questions.length) * 100;
  const editArtist = () => {
    onEditArtist?.();
    window.requestAnimationFrame(() => {
      customInputRef.current?.focus();
      customInputRef.current?.select();
    });
  };

  return (
    <section className="guided-question-screen" aria-labelledby={"guidance-title-" + question.id}>
      <div className="guided-question-body">
        <div className="guided-question-progress">
          <span>QUESTION {currentIndex + 1} OF {questions.length}</span>
          <span aria-hidden="true">{currentIndex + 1}/{questions.length}</span>
        </div>
        <div
          className="guided-progress-rail"
          role="progressbar"
          aria-label="Playlist preferences"
          aria-valuemin={1}
          aria-valuemax={questions.length}
          aria-valuenow={currentIndex + 1}
        >
          <span style={{ width: progress + "%" }} />
        </div>

        <p className="guided-question-kicker">
          {mode === "rescue" ? "FOCUSED RESEARCH DECISION" : question.header || "REFINE THE PLAYLIST"}
        </p>
        <h1
          id={"guidance-title-" + question.id}
          ref={titleRef}
          tabIndex={-1}
        >
          {question.question}
        </h1>
        {question.whyMaterial && (
          <p className="guided-question-reason">
            <span>WHY THIS MATTERS</span>
            {question.whyMaterial}
          </p>
        )}
        {question.grounding?.summary && (
          <p className="guided-question-grounding">
            <span>WHAT THE SCOUT FOUND</span>
            {question.grounding.summary}
          </p>
        )}
        {question.grounding?.sourceUrls?.length ? (
          <p className="guided-question-sources" aria-label="Sources for this question">
            <span>SCOUTED FROM</span>
            {question.grounding.sourceUrls.slice(0, 2).map((sourceUrl, index) => (
              <Fragment key={sourceUrl}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                <a href={sourceUrl} target="_blank" rel="noreferrer">{guidanceSourceLabel(sourceUrl)}</a>
              </Fragment>
            ))}
          </p>
        ) : null}
        {question.interpretationSummary && (
          <section
            className="guided-interpretation-summary"
            aria-labelledby={"guidance-summary-title-" + question.id}
            data-testid="guided-interpretation-summary"
          >
            <h2 id={"guidance-summary-title-" + question.id}>REVISED INTERPRETATION</h2>
            {([
              ["MUST HAVE", question.interpretationSummary.mustHave],
              ["PREFER", question.interpretationSummary.prefer],
              ["AVOID", question.interpretationSummary.avoid],
              ["FLOW", question.interpretationSummary.flow],
            ] as const).map(([label, values]) => (
              <div key={label}>
                <strong>{label}</strong>
                {values.length > 0
                  ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
                  : <span>NO ADDITIONAL RULE</span>}
              </div>
            ))}
            <div>
              <strong>COUNT</strong>
              <span>{question.interpretationSummary.count.toLocaleString()} TRACKS · EXACT</span>
            </div>
            {onChangeEarlierAnswer && (
              <button
                className="quiet-button guidance-history-trigger"
                type="button"
                onClick={onChangeEarlierAnswer}
              >
                CHANGE AN EARLIER ANSWER →
              </button>
            )}
          </section>
        )}

        <fieldset className="guided-options" disabled={busy || locked}>
          <legend className="sr-only">{question.question}</legend>
          {orderedOptions.map((option, index) => {
            const multiple = question.selectionMode === "multiple";
            const selected = multiple
              ? currentAnswer?.optionIds?.includes(option.id) === true
              : currentAnswer?.optionId === option.id;
            const inputId = `${groupName}-option-${index}`;
            const descriptionId = option.description ? inputId + "-description" : undefined;
            return (
              <label
                className="guided-option-card"
                data-selected={selected || undefined}
                key={option.id}
                htmlFor={inputId}
              >
                <input
                  id={inputId}
                  type={multiple ? "checkbox" : "radio"}
                  name={groupName}
                  value={option.id}
                  checked={selected}
                  onChange={() => {
                    if (!multiple) {
                      onAnswer({ questionId: question.id, optionId: option.id });
                      return;
                    }
                    const selectedIds = new Set(currentAnswer?.optionIds ?? []);
                    if (selectedIds.has(option.id)) selectedIds.delete(option.id);
                    else selectedIds.add(option.id);
                    onAnswer({
                      questionId: question.id,
                      optionIds: [...selectedIds],
                    });
                  }}
                  aria-describedby={descriptionId}
                />
                <span className="guided-radio" aria-hidden="true" />
                <span className="guided-option-copy">
                  <strong>
                    {option.label}
                    {option.recommended && <small>RECOMMENDED</small>}
                  </strong>
                  {option.description && <span id={descriptionId}>{option.description}</span>}
                </span>
              </label>
            );
          })}

          {question.allowCustom !== false && <div className="guided-custom-card" data-selected={customSelected || undefined}>
            <label htmlFor={groupName + "-custom-choice"}>
              <input
                id={groupName + "-custom-choice"}
                type="radio"
                name={groupName}
                checked={customSelected}
                onChange={() => {
                  onAnswer({ questionId: question.id, customText });
                  window.requestAnimationFrame(() => customInputRef.current?.focus());
                }}
              />
              <span className="guided-radio" aria-hidden="true" />
              <strong>SOMETHING ELSE</strong>
            </label>
            <input
              ref={customInputRef}
              type="text"
              value={customText}
              maxLength={300}
              placeholder="Type your answer"
              aria-label="Something else"
              onFocus={() => {
                if (!customSelected) onAnswer({ questionId: question.id, customText });
              }}
              onChange={(event) => onAnswer({ questionId: question.id, customText: event.target.value })}
            />
          </div>}
          {question.criticality === "optional" && (
            <label
              className="guided-option-card"
              data-selected={currentAnswer?.skipped || undefined}
              htmlFor={groupName + "-skip"}
            >
              <input
                id={groupName + "-skip"}
                type="radio"
                name={groupName}
                checked={currentAnswer?.skipped === true}
                onChange={() => onAnswer({ questionId: question.id, skipped: true })}
              />
              <span className="guided-radio" aria-hidden="true" />
              <span className="guided-option-copy">
                <strong>{mode === "rescue" ? "KEEP CURRENT CONTRACT" : "USE THE BALANCED DEFAULT"}</strong>
                <span>
                  {mode === "rescue"
                    ? "Skip this rescue revision without weakening or changing any rule."
                    : "Skip this optional preference without changing the playlist scope."}
                </span>
              </span>
            </label>
          )}
        </fieldset>
      </div>

      <div className="guided-question-footer">
        <button
          className="guided-back"
          type="button"
          onClick={recoveryMode ? editArtist : onBack}
          disabled={busy}
        >
          ← {recoveryMode
            ? "EDIT ARTIST"
            : mode === "rescue"
            ? "KEEP CURRENT CONTRACT"
            : locked || currentIndex === 0
              ? "EDIT REQUEST"
              : "BACK"}
        </button>
        <button
          className="guided-next"
          type="button"
          onClick={onNext}
          disabled={busy || !validAnswer}
        >
          {busy
            ? mode === "rescue" ? "APPLYING..." : "FINALIZING..."
            : recoveryMode === "retry_lookup"
              ? "RETRY LOOKUP →"
              : recoveryMode === "configuration"
                ? "TRY A DIFFERENT ARTIST →"
              : recoveryMode === "edit_artist"
                ? "VERIFY ARTIST →"
                : locked
              ? "RETRY CREATE →"
              : lastQuestion
                ? mode === "rescue" ? "APPLY AND CONTINUE →" : "CREATE PLAYLIST →"
                : "NEXT →"}
        </button>
      </div>
    </section>
  );
}

function InterpretationSummaryScreen({
  action,
  busy,
  onChangeEarlierAnswer,
  onResumeLater,
  onCancel,
}: {
  action: Extract<RunGuidanceActionView, { kind: "interpretation_summary" }>;
  busy: boolean;
  onChangeEarlierAnswer: () => void;
  onResumeLater: () => void;
  onCancel: () => void;
}) {
  const summary = action.interpretationSummary;
  return (
    <section
      className="guided-question-screen"
      aria-labelledby="interpretation-summary-title"
      data-testid="clarification-limit-summary"
    >
      <div className="guided-question-body">
        <p className="guided-question-kicker">ACTION NEEDED</p>
        <h1 id="interpretation-summary-title">
          {action.reason === "clarification_attempt_limit"
            ? "Clarification limit reached"
            : "Research questions are complete"}
        </h1>
        <p className="guided-question-reason">
          <span>WHY RESEARCH PAUSED</span>
          {action.reason === "clarification_attempt_limit"
            ? "Two clarification attempts reached the same decision axis. Review the saved interpretation instead of answering another generated question."
            : "The bounded rescue-question budget is complete. Your exact count and every saved rule remain unchanged."}
        </p>
        <section
          className="guided-interpretation-summary"
          aria-labelledby="clarification-limit-contract-title"
          data-testid="clarification-limit-contract"
        >
          <h2 id="clarification-limit-contract-title">EDITABLE INTERPRETATION</h2>
          {([
            ["MUST HAVE", summary.mustHave],
            ["PREFER", summary.prefer],
            ["AVOID", summary.avoid],
            ["FLOW", summary.flow],
          ] as const).map(([label, values]) => (
            <div key={label}>
              <strong>{label}</strong>
              {values.length > 0
                ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
                : <span>NO ADDITIONAL RULE</span>}
            </div>
          ))}
          <div>
            <strong>COUNT</strong>
            <span>{summary.count.toLocaleString()} TRACKS · EXACT</span>
          </div>
        </section>
        <small>
          ATTEMPTS · {action.attemptsUsed.toLocaleString()} OF{" "}
          {action.maximumAttempts.toLocaleString()}
        </small>
      </div>
      <div className="guided-question-footer">
        {action.actions.resumeLater && (
          <button
            className="guided-back"
            type="button"
            onClick={onResumeLater}
            disabled={busy}
          >
            ← RETURN TO JOBS
          </button>
        )}
        {action.actions.changeEarlierAnswer && (
          <button
            className="guided-next"
            type="button"
            onClick={onChangeEarlierAnswer}
            disabled={busy}
          >
            CHANGE AN EARLIER ANSWER →
          </button>
        )}
        {action.actions.cancel && (
          <button
            className="text-danger"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            CANCEL JOB
          </button>
        )}
      </div>
    </section>
  );
}

function GuidanceHistoryScreen({
  history,
  busy,
  confirmation,
  onBack,
  onRevise,
}: {
  history: GuidanceHistoryView;
  busy: boolean;
  confirmation: GuidanceRevisionConfirmation | null;
  onBack: () => void;
  onRevise: (
    item: GuidanceHistoryItem,
    answer: GuidedAnswer,
    confirmationHash?: string,
  ) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(
    history.items[0]
      ? `${history.items[0].answerSetId}:${history.items[0].question.id}`
      : "",
  );
  const [answer, setAnswer] = useState<GuidedAnswer | null>(null);
  const selected = history.items.find((item) => (
    `${item.answerSetId}:${item.question.id}` === selectedKey
  )) ?? null;
  if (confirmation) {
    const summary = confirmation.interpretationSummary;
    return (
      <section
        className="guided-question-screen guidance-history-screen"
        aria-labelledby="guidance-history-confirm-title"
        data-testid="guidance-history-confirmation"
      >
        <div className="guided-question-body">
          <span className="guided-question-kicker">CONFIRM HARD CHANGES</span>
          <h1 id="guidance-history-confirm-title">Review the revised interpretation</h1>
          <p>
            Your custom answer changes an executable rule. Nothing changes
            until you confirm this exact summary.
          </p>
          <section className="guided-interpretation-summary">
            <h2>REVISED INTERPRETATION</h2>
            {([
              ["MUST HAVE", summary.mustHave],
              ["PREFER", summary.prefer],
              ["AVOID", summary.avoid],
              ["FLOW", summary.flow],
            ] as const).map(([label, values]) => (
              <div key={label}>
                <strong>{label}</strong>
                {values.length
                  ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
                  : <span>NO ADDITIONAL RULE</span>}
              </div>
            ))}
            <div>
              <strong>COUNT</strong>
              <span>{summary.count.toLocaleString()} TRACKS · EXACT</span>
            </div>
          </section>
        </div>
        <div className="step-footer">
          <button className="quiet-button" type="button" onClick={onBack} disabled={busy}>
            CANCEL
          </button>
          <button
            className="guided-next"
            type="button"
            disabled={busy}
            onClick={() => onRevise(
              confirmation.item,
              confirmation.answer,
              confirmation.confirmationHash,
            )}
          >
            {busy ? "APPLYING..." : "CONFIRM AND CREATE SUCCESSOR →"}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section
      className="guided-question-screen guidance-history-screen"
      aria-labelledby="guidance-history-title"
      data-testid="guidance-history-screen"
    >
      <div className="guided-question-body">
        <span className="guided-question-kicker">IMMUTABLE GUIDANCE HISTORY</span>
        <h1 id="guidance-history-title">Change an earlier answer</h1>
        <p>
          The earlier contract stays in history. Your change creates a fenced
          successor and asks again only about later decisions that still matter.
        </p>
        {history.items.length === 0 ? (
          <p role="status">There are no active guidance answers to revise.</p>
        ) : (
          <>
            <div className="guidance-history-list">
              {history.items.map((item) => {
                const key = `${item.answerSetId}:${item.question.id}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className="quiet-button"
                    aria-pressed={key === selectedKey}
                    onClick={() => {
                      setSelectedKey(key);
                      setAnswer(null);
                    }}
                  >
                    <strong>{item.question.header || "PLAYLIST DECISION"}</strong>
                    <span>{item.question.question}</span>
                    <small>
                      CURRENT · {item.skipped
                        ? "SKIPPED"
                        : item.hadCustomAnswer
                          ? "CUSTOM RULE (TEXT HIDDEN)"
                        : item.selectedOptionLabels.join(", ")
                          || "NO EXECUTABLE CHANGE"}
                    </small>
                  </button>
                );
              })}
            </div>
            {selected && (
              <fieldset className="guided-options" disabled={busy}>
                <legend>{selected.question.question}</legend>
                {selected.question.options.map((option, index) => {
                  const multiple = selected.question.selectionMode === "multiple";
                  const chosen = multiple
                    ? answer?.optionIds?.includes(option.id) === true
                    : answer?.optionId === option.id;
                  const current = selected.selectedOptionIds.includes(option.id);
                  const id = `history-${selected.question.id}-${index}`;
                  return (
                    <label
                      className="guided-option-card"
                      data-selected={chosen || undefined}
                      key={option.id}
                      htmlFor={id}
                    >
                      <input
                        id={id}
                        type={multiple ? "checkbox" : "radio"}
                        name={`history-${selected.question.id}`}
                        checked={chosen}
                        onChange={() => {
                          if (!multiple) {
                            setAnswer({
                              questionId: selected.question.id,
                              optionId: option.id,
                            });
                            return;
                          }
                          const next = new Set(answer?.optionIds ?? []);
                          if (next.has(option.id)) next.delete(option.id);
                          else next.add(option.id);
                          setAnswer({
                            questionId: selected.question.id,
                            optionIds: [...next],
                          });
                        }}
                      />
                      <span className="guided-radio" aria-hidden="true" />
                      <span className="guided-option-copy">
                        <strong>
                          {option.label}
                          {current && <small>CURRENT</small>}
                        </strong>
                        {option.description && <span>{option.description}</span>}
                      </span>
                    </label>
                  );
                })}
                {selected.question.allowCustom && (
                  <label className="guided-custom-card">
                    <strong>SOMETHING ELSE</strong>
                    <input
                      type="text"
                      maxLength={500}
                      aria-label="Custom replacement answer"
                      placeholder="Type a specific music rule"
                      value={answer?.customText ?? ""}
                      onChange={(event) => setAnswer({
                        questionId: selected.question.id,
                        customText: event.target.value,
                      })}
                    />
                  </label>
                )}
                {selected.question.criticality === "optional" && (
                  <button
                    className="quiet-button"
                    type="button"
                    aria-pressed={answer?.skipped === true}
                    onClick={() => setAnswer({
                      questionId: selected.question.id,
                      skipped: true,
                    })}
                  >
                    SKIP THIS OPTIONAL DECISION
                    {selected.skipped ? " · CURRENT" : ""}
                  </button>
                )}
              </fieldset>
            )}
          </>
        )}
      </div>
      <div className="step-footer">
        <button className="quiet-button" type="button" onClick={onBack} disabled={busy}>
          BACK
        </button>
        <button
          className="guided-next"
          type="button"
          disabled={!selected || !answer || busy || (
            answer.optionId !== undefined
            && selected.selectedOptionIds.length === 1
            && selected.selectedOptionIds[0] === answer.optionId
          ) || (
            answer.optionIds !== undefined
            && answer.optionIds.length === 0
          ) || (
            answer.optionIds !== undefined
            && [...answer.optionIds].sort().join("\u0000")
              === [...selected.selectedOptionIds].sort().join("\u0000")
          ) || (
            answer.customText !== undefined
            && answer.customText.trim().length === 0
          ) || (
            answer.skipped === true && selected.skipped
          )}
          onClick={() => selected && answer && onRevise(selected, answer)}
        >
          {busy ? "CREATING SUCCESSOR..." : "APPLY CHANGE →"}
        </button>
      </div>
    </section>
  );
}

function FinalizingBriefScreen() {
  return (
    <section className="guided-question-screen guided-finalizing-screen">
      <div className="guided-question-body">
        <span className="guided-question-kicker">PREPARING</span>
        <h1>Preparing your playlist</h1>
        <p>Applying your answers before research begins.</p>
        <WorkingIndicator
          stage="plan"
          motion="active"
          phaseLabel="Applying your answers and finalizing the request."
          compact
        />
      </div>
    </section>
  );
}

function preserveFeedbackSource(): void {
  try {
    window.sessionStorage.setItem("9enio.feedback.sourcePath", window.location.pathname);
  } catch {
    // The feedback page still accepts a report when storage is unavailable.
  }
}

function RunScreen({
  run,
  busy,
  onNew,
  onRefine,
  onResumeDependency,
  onChangeEarlierAnswer,
  onCancel,
}: {
  run: ResearchRun;
  busy: string;
  onNew: () => void;
  onRefine: () => void;
  onResumeDependency: () => void;
  onChangeEarlierAnswer: () => void;
  onCancel: () => void;
}) {
  const showReset = run.resolution ? run.resolution.terminal : terminalStatuses.has(run.status);
  const controls = runResolutionControls(run);
  const needsDecision = run.resolution?.state === "needs_decision"
    || run.resolution?.state === "needs_input"
    || run.resolution?.state === "quarantined";
  const dependencyPaused = run.resolution?.state === "blocked_dependency";
  const controlSuccessorRequired =
    run.phase === "public_rollout_successor_required";
  const profile = run.brief.mode === "curated" ? "CURATED" : "EXHAUSTIVE";
  const automaticHandoff = isAutomaticPlaylistHandoff(run);
  const publishing = automaticHandoff
    || ["publishing", "waiting_for_apple_authorization", "manifest_ready"].includes(run.status);
  const work = playlistWorkState(run);
  const targetCount = run.selectionPlan?.requestedTrackCount
    ?? run.pipelineOutcome?.targetTrackCount
    ?? exactRequestedTrackCount(run.brief);

  return (
    <section
      className="screen flow-screen research-screen"
      aria-labelledby="run-title"
      aria-busy={work.motion === "active"}
    >
      <div className="flow-body research-body">
        <span className="tag profile-tag">[{profile} · {automaticHandoff ? "ASSEMBLING" : statusLabel(run.status).toUpperCase()}]</span>
        <h1 id="run-title">{
          dependencyPaused
            ? "Your playlist is safely paused"
            : publishing
            ? "Creating your playlist"
            : needsDecision
              ? "Your playlist needs a decision"
              : "Researching your playlist"
        }</h1>
        <p className="run-subject">{run.brief.title}</p>
        <WorkingIndicator
          stage={work.stage}
          motion={work.motion}
          phaseLabel={phaseMessage(run)}
          sourceCount={run.sourceCount}
          candidateCount={run.candidateCount}
          unresolvedCount={run.unresolvedCount}
          targetCount={run.progress?.targetTrackCount ?? targetCount}
          reserveCount={run.selectionPlan?.reserveTrackCount}
          candidateStageCounts={run.candidateStageCounts}
          frontier={run.frontier}
          createdAt={run.createdAt}
          updatedAt={run.updatedAt}
          progress={run.progress}
          details={{
            relationship: run.brief.relationship,
            evidencePolicy: run.brief.evidencePolicy,
            versionPolicy: run.brief.versionPolicy,
            intents: run.selectionPlan?.intents,
            storefront: run.selectionPlan?.storefront,
            pipelineVersion: run.pipelineVersion,
          }}
          note={work.motion === "active" ? "Progress is saved in Jobs. You can leave this page." : undefined}
        />
        {run.decisionAction && (
          <div className="run-decision-panel" data-testid="run-decision-panel">
            <span>SAFE RESEARCH BOUNDARY</span>
            <p>
              {run.decisionAction.reason === "dependency_retry_window_expired"
                ? "The 24-hour automatic retry window ended. This is a service dependency state, not a claim that the music does not exist."
                : run.decisionAction.reason === "central_quality_floor"
                  ? "The count alone was not enough: the central suitability floor was missed, so nothing was published."
                  : run.decisionAction.reason === "playlist_optimization_constraints"
                    ? "Qualified tracks were found, but the playlist-level diversity, quota, or sequencing constraints could not all be satisfied. Nothing was published or silently relaxed."
                  : "Automated research paused without changing your playlist contract."}
            </p>
            {run.decisionAction.namedPredicates[0] && (
              <small>
                NAMED BOTTLENECK · {run.decisionAction.namedPredicates[0].label}
              </small>
            )}
            <small>
              COUNT REMAINS EXACT · {run.decisionAction.targetTrackCount.toLocaleString()} TRACKS
            </small>
            <section
              className="guided-interpretation-summary run-decision-interpretation"
              aria-labelledby="run-boundary-interpretation-title"
              data-testid="run-boundary-interpretation"
            >
              <h2 id="run-boundary-interpretation-title">EDITABLE INTERPRETATION</h2>
              {([
                ["MUST HAVE", run.decisionAction.interpretationSummary.mustHave],
                ["PREFER", run.decisionAction.interpretationSummary.prefer],
                ["AVOID", run.decisionAction.interpretationSummary.avoid],
                ["FLOW", run.decisionAction.interpretationSummary.flow],
              ] as const).map(([label, values]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  {values.length > 0
                    ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
                    : <span>NO ADDITIONAL RULE</span>}
                </div>
              ))}
              <div>
                <strong>COUNT</strong>
                <span>{run.decisionAction.targetTrackCount.toLocaleString()} TRACKS · EXACT</span>
              </div>
              <button
                className="quiet-button guidance-history-trigger"
                type="button"
                onClick={onChangeEarlierAnswer}
              >
                CHANGE AN EARLIER ANSWER →
              </button>
            </section>
            {run.decisionAction.actions.resumeLater && (
              <small>PROGRESS IS SAVED · YOU MAY RETURN FROM JOBS AT ANY TIME</small>
            )}
          </div>
        )}
        {controlSuccessorRequired && (
          <div
            className="run-decision-panel"
            data-testid="public-rollout-successor-decision"
          >
            <span>SAFE ROLLOUT BOUNDARY</span>
            <p>
              Your accepted request is unchanged and remains saved. Its
              confirmed capabilities are outside the current signed cohort,
              so it will not be silently downgraded or resumed automatically.
              Create a user-authored revision now, or cancel this saved run.
            </p>
            <small>
              COUNT REMAINS EXACT · {targetCount?.toLocaleString() ?? "—"} TRACKS
            </small>
            <small>
              SAVED DURABLY · REFINE OR CANCEL
            </small>
          </div>
        )}
      </div>

      {(showReset || controls.length > 0 || controlSuccessorRequired) && (
        <div className="step-footer run-action-footer">
          {controls.includes("wait_for_retry") && (
            <p className="run-action-status" role="status">
              {run.resolution?.blocker?.nextRetryAt
                ? `AUTOMATIC RETRY SCHEDULED · ${new Date(run.resolution.blocker.nextRetryAt).toLocaleString()}`
                : run.status === "waiting_for_apple_authorization"
                  ? "NO ACTION REQUIRED · PUBLICATION RESUMES AFTER THE OWNER RECONNECTS APPLE MUSIC"
                  : "NO ACTION REQUIRED · PROGRESS IS SAVED FOR THE NEXT AUTOMATIC RETRY"}
            </p>
          )}
          {controls.includes("contact_support") && (
            <a
              className="action-button step-primary"
              href="/feedback"
              onClick={preserveFeedbackSource}
            >
              CONTACT SUPPORT →
            </a>
          )}
          {controls.includes("resume_dependency") && (
            <button
              className="action-button step-primary"
              type="button"
              onClick={onResumeDependency}
              disabled={Boolean(busy)}
            >
              {busy === "resume-dependency"
                ? "SCHEDULING RESUME..."
                : "RESUME LATER →"}
            </button>
          )}
          {controls.includes("refine_request") && (
            <button
              className={controls.includes("contact_support") ? "quiet-button" : "action-button step-primary"}
              type="button"
              onClick={onRefine}
              disabled={Boolean(busy)}
            >
              {run.decisionAction?.actions.reviseNamedPredicate
                && run.decisionAction.namedPredicates[0]
                ? `REVISE “${run.decisionAction.namedPredicates[0].label}” →`
                : run.decisionAction?.actions.reduceCount
                  ? "CREATE A SEPARATE COUNT REVISION →"
                  : "REFINE REQUEST →"}
            </button>
          )}
          {controls.includes("cancel_job") && (
            <button
              className="text-danger"
              type="button"
              onClick={onCancel}
              disabled={Boolean(busy)}
            >
              {busy === "cancel-run" ? "CANCELING..." : "CANCEL JOB"}
            </button>
          )}
          {showReset && controls.length === 0 && (
            <button className="action-button step-primary" type="button" onClick={onNew}>
              NEW JOB →
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function PartialDecisionScreen({
  decision,
  boundary,
  busy,
  onContinueResearch,
  onPublishPartial,
  onChangeRequest,
  onChangeEarlierAnswer,
  onCancel,
}: {
  decision: PartialReadyView;
  boundary?: RunDecisionActionView | null;
  busy: string;
  onContinueResearch: () => void;
  onPublishPartial: () => void;
  onChangeRequest: () => void;
  onChangeEarlierAnswer: () => void;
  onCancel: () => void;
}) {
  const hasTracks = decision.qualifiedTrackCount > 0;
  const reason = boundary?.reason === "active_compute_limit"
    ? "The active 15-minute research pass completed without changing your contract."
    : boundary?.reason === "central_quality_floor"
      ? "The requested count was not allowed through because the central quality floor was missed."
      : boundary?.reason === "playlist_optimization_constraints"
        ? "Qualified tracks were found, but the playlist-level diversity, quota, or sequencing constraints could not all be satisfied."
      : decision.reasonCode
        ? statusLabel(decision.reasonCode).replace(/^partial /iu, "")
        : "The remaining tracks did not clear the current evidence and Apple Music checks.";
  const canRunBoundedPass = decision.canContinueResearch
    && (boundary ? boundary.actions.anotherBoundedPass : true);
  const canPublishPartial = hasTracks
    && (boundary ? boundary.actions.publishVerifiedPartial : true);

  return (
    <section
      className="screen flow-screen partial-decision-screen"
      aria-labelledby="partial-decision-title"
      data-testid="partial-decision-screen"
    >
      <div className="flow-body partial-decision-body">
        <span className="tag">[ACTION NEEDED]</span>
        <h1 id="partial-decision-title">{partialDecisionHeading(decision.qualifiedTrackCount)}</h1>
        <p className="partial-decision-summary">
          {partialDecisionSummary(decision.qualifiedTrackCount, decision.targetTrackCount)}
        </p>

        <div className="partial-decision-meter" aria-label="Verified playlist progress">
          <div>
            <span>VERIFIED</span>
            <strong>{decision.qualifiedTrackCount.toLocaleString()}</strong>
          </div>
          <div>
            <span>REQUESTED</span>
            <strong>{decision.targetTrackCount.toLocaleString()}</strong>
          </div>
          <div>
            <span>REMAINING</span>
            <strong>{decision.deficit.toLocaleString()}</strong>
          </div>
        </div>

        <div className="partial-decision-note">
          <span>WHY RESEARCH PAUSED</span>
          <p>{reason} No playlist has been published yet.</p>
          {canRunBoundedPass && (
            <small>
              {decision.remainingStrategyCount.toLocaleString()} additional research {decision.remainingStrategyCount === 1 ? "strategy is" : "strategies are"} available in one more bounded pass.
            </small>
          )}
        </div>

        {boundary?.interpretationSummary && (
          <section
            className="guided-interpretation-summary run-decision-interpretation"
            aria-labelledby="run-decision-interpretation-title"
            data-testid="run-decision-interpretation"
          >
            <h2 id="run-decision-interpretation-title">CURRENT INTERPRETATION</h2>
            {([
              ["MUST HAVE", boundary.interpretationSummary.mustHave],
              ["PREFER", boundary.interpretationSummary.prefer],
              ["AVOID", boundary.interpretationSummary.avoid],
              ["FLOW", boundary.interpretationSummary.flow],
            ] as const).map(([label, values]) => (
              <div key={label}>
                <strong>{label}</strong>
                {values.length > 0
                  ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
                  : <span>NO ADDITIONAL RULE</span>}
              </div>
            ))}
            <div>
              <strong>COUNT</strong>
              <span>{boundary.interpretationSummary.count.toLocaleString()} TRACKS · EXACT</span>
            </div>
            <button
              className="quiet-button guidance-history-trigger"
              type="button"
              onClick={onChangeEarlierAnswer}
            >
              CHANGE AN EARLIER ANSWER →
            </button>
          </section>
        )}

        <div className="partial-decision-actions">
          {canRunBoundedPass && (
            <button
              className="action-button step-primary"
              type="button"
              onClick={onContinueResearch}
              disabled={Boolean(busy)}
            >
              {busy === "continue-research" ? "STARTING BOUNDED PASS..." : "RUN ONE MORE BOUNDED PASS →"}
            </button>
          )}
          <button
            className="quiet-button partial-publish-button"
            type="button"
            onClick={onPublishPartial}
            disabled={!canPublishPartial || Boolean(busy)}
          >
            {busy === "publish-partial"
              ? "PREPARING PLAYLIST..."
              : hasTracks
                ? `PUBLISH ${decision.qualifiedTrackCount.toLocaleString()} VERIFIED TRACKS`
                : "NO VERIFIED TRACKS TO PUBLISH"}
          </button>
          {boundary?.actions.reviseNamedPredicate && boundary.namedPredicates[0] && (
            <button className="quiet-button" type="button" onClick={onChangeRequest} disabled={Boolean(busy)}>
              REVISE “{boundary.namedPredicates[0].label}” →
            </button>
          )}
          {boundary?.actions.reduceCount && (
            <button className="quiet-button" type="button" onClick={onChangeRequest} disabled={Boolean(busy)}>
              CREATE A SEPARATE COUNT REVISION →
            </button>
          )}
          {!boundary && (
            <button className="quiet-button" type="button" onClick={onChangeRequest} disabled={Boolean(busy)}>
              {hasTracks ? "CHANGE REQUEST" : "RETRY WITH UPDATED INTERPRETATION"}
            </button>
          )}
          <button className="text-danger" type="button" onClick={onCancel} disabled={Boolean(busy)}>
            {busy === "cancel-run" ? "CANCELING..." : "CANCEL JOB"}
          </button>
        </div>
        <p className="partial-decision-saved">This decision is saved in Jobs. You can return later.</p>
      </div>
    </section>
  );
}

function ReviewScreen(props: {
  selection: TrackSelection | null;
  busy: string;
  onRetry: () => void;
  onGenerate: (request: TrackSelectionRequest) => void;
}) {
  if (props.selection) {
    return <TrackSelectionScreen {...props} selection={props.selection} />;
  }
  return (
    <section className="screen flow-screen review-screen" aria-labelledby="review-title">
      <div className="flow-body review-body">
        <h1 id="review-title">Choose tracks</h1>
        <p>Loading Apple Music matches.</p>
        <WorkingIndicator
          stage="match"
          motion="active"
          phaseLabel="LOADING TRACKS"
          compact
        />
      </div>
      <div className="step-footer review-footer">
        <div className="selection-count"><strong>0</strong><span>TRACKS</span></div>
        <button className="action-button step-primary" disabled>CONTINUE →</button>
      </div>
    </section>
  );
}

function TrackSelectionScreen({
  selection,
  busy,
  onRetry,
  onGenerate,
}: {
  selection: TrackSelection;
  busy: string;
  onRetry: () => void;
  onGenerate: (request: TrackSelectionRequest) => void;
}) {
  const requestedTrackCount = selection.requestedTrackCount;
  const recommendedCandidates = useMemo(
    () => selection.items.filter(recommendedByDefault),
    [selection.items],
  );
  // When matching originally satisfied the request, visitors may still make
  // an intentional shorter playlist by unchecking tracks. A run that reached
  // review with a catalog shortfall must first resolve enough Apple choices to
  // meet the requested count; it can no longer silently publish a partial.
  const initialRequestSatisfied = requestedTrackCount === null
    || recommendedCandidates.length >= requestedTrackCount;
  const [catalogIds, setCatalogIds] = useState<Record<string, string>>(() => {
    const nextCatalogIds: Record<string, string> = {};
    for (const item of selection.items) {
      const catalogId = recommendedCatalogId(item);
      if (!item.selectable || !catalogId) continue;
      nextCatalogIds[item.candidateId] = catalogId;
    }
    return nextCatalogIds;
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(
    recommendedCandidates
      .slice(0, requestedTrackCount ?? undefined)
      .map((item) => item.candidateId),
  ));

  const manualChoiceCandidateIds = useMemo(() => new Set(
    selection.items
      .filter((item) => !item.selectable && trackChoices(item).length > 0)
      .map((item) => item.candidateId),
  ), [selection.items]);

  const selectable = useMemo(
    () => selection.items.filter((item) => (
      Boolean(catalogIds[item.candidateId])
      && (item.selectable || manualChoiceCandidateIds.has(item.candidateId))
    )),
    [selection, catalogIds, manualChoiceCandidateIds],
  );
  const selected = useMemo(
    () => selectable.filter((item) => selectedIds.has(item.candidateId)),
    [selectable, selectedIds],
  );
  const selectAllCandidates = useMemo(
    () => selectable.slice(0, requestedTrackCount ?? undefined),
    [selectable, requestedTrackCount],
  );

  const retryableCandidateIds = useMemo(() => {
    const explicit = selection.items.filter((item) => (
      !item.selectable
      && item.status === "review"
      && (typeof item.retryable === "boolean"
        ? item.retryable
        : RETRYABLE_APPLE_MATCH_BASES.has(item.basis ?? ""))
    ));
    const ids = new Set(explicit.map((item) => item.candidateId));
    let remaining = Math.max(0, selection.retryableCount - ids.size);
    if (remaining === 0) return ids;

    // Older API responses did not expose retryability per row. Use the page
    // total to identify otherwise-unclassified review rows without treating a
    // completed recovery failure as retryable.
    for (const item of selection.items) {
      if (remaining === 0) break;
      if (item.selectable
        || item.status !== "review"
        || item.retryable === false
        || (item.basis === FAILED_APPLE_MATCH_BASIS && item.retryable !== true)
        || ids.has(item.candidateId)) continue;
      ids.add(item.candidateId);
      remaining -= 1;
    }
    return ids;
  }, [selection]);

  const reviewStateByCandidateId = useMemo(() => new Map(
    selection.items.map((item): [string, TrackReviewState] => {
      if (item.selectable && Boolean(recommendedCatalogId(item))) {
        return [item.candidateId, item.status === "rejected" ? "excluded" : "matched"];
      }
      if (manualChoiceCandidateIds.has(item.candidateId)) {
        return [item.candidateId, catalogIds[item.candidateId] ? "matched" : "choose-match"];
      }
      if (retryableCandidateIds.has(item.candidateId)) return [item.candidateId, "needs-match"];
      if (item.status === "unavailable") return [item.candidateId, "unavailable"];
      if (item.basis === FAILED_APPLE_MATCH_BASIS || ["review", "pending"].includes(item.status)) {
        return [item.candidateId, "match-failed"];
      }
      return [item.candidateId, "excluded"];
    }),
  ), [selection.items, retryableCandidateIds, manualChoiceCandidateIds, catalogIds]);

  const chooseMatchCount = [...reviewStateByCandidateId.values()].filter((state) => state === "choose-match").length;
  const needsMatchCount = [...reviewStateByCandidateId.values()].filter((state) => state === "needs-match").length;
  const matchFailedCount = [...reviewStateByCandidateId.values()].filter((state) => state === "match-failed").length;
  const unavailableCount = [...reviewStateByCandidateId.values()].filter((state) => state === "unavailable").length;
  const requestedShortfall = requestedTrackCount === null
    ? 0
    : Math.max(0, requestedTrackCount - selected.length);
  const blocksPartialGeneration = !initialRequestSatisfied && requestedShortfall > 0;

  let reviewSummary: string;
  if (selection.items.length === 0) {
    reviewSummary = "No tracks are available to generate.";
  } else if (blocksPartialGeneration && requestedTrackCount) {
    reviewSummary = `${selected.length.toLocaleString()} of ${requestedTrackCount.toLocaleString()} requested tracks are ready. Resolve ${requestedShortfall.toLocaleString()} more Apple Music ${requestedShortfall === 1 ? "match" : "matches"} to generate the playlist.`;
  } else if (chooseMatchCount > 0) {
    const remaining = [
      needsMatchCount > 0 ? ` Retry matching for ${trackCountLabel(needsMatchCount)}.` : "",
      unavailableCount > 0 ? ` ${unavailableTrackCountLabel(unavailableCount)} will be omitted.` : "",
    ].join("");
    reviewSummary = `${trackCountLabel(selectable.length)} matched. Choose an Apple Music version for ${trackCountLabel(chooseMatchCount)} to make those tracks selectable.${remaining}`;
  } else if (needsMatchCount > 0) {
    const unavailableNote = unavailableCount > 0
      ? `; ${unavailableTrackCountLabel(unavailableCount)} will be omitted`
      : "";
    reviewSummary = selectable.length > 0
      ? `${trackCountLabel(selectable.length)} matched. Retry matching for ${trackCountLabel(needsMatchCount)}, or generate the matched tracks now${unavailableNote}.`
      : `Apple Music matching is incomplete for ${trackCountLabel(needsMatchCount)}. Retry matching${unavailableNote || " before generating a playlist"}.`;
  } else if (selectable.length === 0 && matchFailedCount > 0) {
    const unavailableNote = unavailableCount > 0
      ? ` ${trackCountLabel(unavailableCount)} ${unavailableCount === 1 ? "is" : "are"} unavailable.`
      : " No playlist can be generated yet.";
    reviewSummary = `Apple Music matching failed for ${trackCountLabel(matchFailedCount)}.${unavailableNote}`;
  } else if (selectable.length === 0) {
    reviewSummary = unavailableCount > 0
      ? `No tracks matched Apple Music. ${trackCountLabel(unavailableCount)} ${unavailableCount === 1 ? "is" : "are"} unavailable.`
      : "No tracks can be included in this playlist.";
  } else if (matchFailedCount > 0 || unavailableCount > 0) {
    const omissions = [
      matchFailedCount > 0 ? `${trackCountLabel(matchFailedCount)} failed matching` : "",
      unavailableCount > 0 ? unavailableTrackCountLabel(unavailableCount) : "",
    ].filter(Boolean).join("; ");
    reviewSummary = `${trackCountLabel(selectable.length)} matched. Omitted: ${omissions}.`;
  } else if (requestedTrackCount && selectable.length > requestedTrackCount) {
    reviewSummary = `${trackCountLabel(selected.length)} selected from ${trackCountLabel(selectable.length)} matched. Additional matches are available as replacements.`;
  } else {
    reviewSummary = `${trackCountLabel(selectable.length)} matched. Uncheck any you do not want.`;
  }

  function setAll(checked: boolean) {
    setSelectedIds(checked ? new Set(selectAllCandidates.map((item) => item.candidateId)) : new Set());
  }

  function toggle(candidateId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        if (requestedTrackCount && !next.has(candidateId) && next.size >= requestedTrackCount) {
          const replacement = [...selection.items]
            .reverse()
            .find((item) => next.has(item.candidateId));
          if (replacement) next.delete(replacement.candidateId);
        }
        next.add(candidateId);
      } else next.delete(candidateId);
      return next;
    });
  }

  function chooseCatalog(item: SelectableTrack, catalogId: string) {
    setCatalogIds((current) => ({ ...current, [item.candidateId]: catalogId }));
  }

  function generate() {
    if (!selection || selected.length === 0) return;
    const explicit: TrackSelectionRequest = {
      selected: selected.map((item) => ({
        candidateId: item.candidateId,
        catalogId: catalogIds[item.candidateId]!,
      })),
    };
    const recommended: TrackSelectionRequest = {
      useRecommended: true,
      excludedCandidateIds: selection.items
        .filter((item) => recommendedByDefault(item) && !selectedIds.has(item.candidateId))
        .map((item) => item.candidateId),
      overrides: selected
        .filter((item) => !recommendedByDefault(item) || recommendedCatalogId(item) !== catalogIds[item.candidateId])
        .map((item) => ({ candidateId: item.candidateId, catalogId: catalogIds[item.candidateId]! })),
    };
    const request = JSON.stringify(recommended).length <= JSON.stringify(explicit).length ? recommended : explicit;
    onGenerate(request);
  }

  const allSelected = selectAllCandidates.length > 0
    && selected.length === selectAllCandidates.length
    && selectAllCandidates.every((item) => selectedIds.has(item.candidateId));
  return (
    <section className="screen flow-screen review-screen" aria-labelledby="review-title">
      <div className="flow-body review-body">
        <h1 id="review-title">Choose tracks</h1>
        <p aria-live="polite">{reviewSummary}</p>

            <div className="selection-toolbar" role="group" aria-label="Track selection controls">
              <span>{selected.length.toLocaleString()} OF {selectable.length.toLocaleString()} MATCHED TRACKS SELECTED</span>
              <div>
                <button type="button" onClick={() => setAll(true)} disabled={selectable.length === 0 || allSelected || Boolean(busy)}>SELECT ALL</button>
                <button type="button" onClick={() => setAll(false)} disabled={selected.length === 0 || Boolean(busy)}>CLEAR</button>
              </div>
            </div>

            {needsMatchCount > 0 && (
              <button
                className="matching-retry"
                type="button"
                onClick={onRetry}
                disabled={Boolean(busy)}
                aria-label={`Retry Apple Music matching for ${trackCountLabel(needsMatchCount)}`}
              >
                {busy === "matching" ? "RETRYING APPLE MUSIC..." : `RETRY MATCHING · ${needsMatchCount.toLocaleString()} →`}
              </button>
            )}

            <ol className="track-selection-list" aria-label="Playlist tracks">
              {selection.items.map((item, index) => {
                const choices = trackChoices(item);
                const checked = selectedIds.has(item.candidateId);
                const needsChoice = manualChoiceCandidateIds.has(item.candidateId);
                const disabled = !(item.selectable || Boolean(catalogIds[item.candidateId])) || choices.length === 0;
                const terminallyUnavailable = disabled && !needsChoice;
                const reviewState = reviewStateByCandidateId.get(item.candidateId) ?? "unavailable";
                const displayedState = reviewState === "excluded" && checked ? "matched" : reviewState;
                return (
                  <li className={`track-selection-row${terminallyUnavailable ? " unavailable" : ""}${needsChoice ? " needs-choice" : ""}`} key={item.candidateId}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Include ${item.title} by ${item.artist}`}
                        checked={checked}
                        disabled={disabled || Boolean(busy)}
                        onChange={(event) => toggle(item.candidateId, event.target.checked)}
                      />
                      <span className="track-position">{String(index + 1).padStart(3, "0")}</span>
                      <span className="track-copy">
                        <strong>{item.title}</strong>
                        <small>{item.artist}{item.album ? " / " + item.album : ""}</small>
                      </span>
                      <span className="track-match-state">
                        {trackReviewLabel(displayedState)}
                      </span>
                    </label>
                    {((item.selectable && choices.length > 1) || needsChoice) && (
                      <label className="match-choice">
                        <span>APPLE MUSIC VERSION</span>
                        <select
                          value={catalogIds[item.candidateId] ?? ""}
                          disabled={Boolean(busy)}
                          onChange={(event) => chooseCatalog(item, event.target.value)}
                        >
                          {needsChoice && <option value="" disabled>CHOOSE A VERSION</option>}
                          {choices.map((song) => (
                            <option value={song.id} key={song.id}>
                              {song.name} — {song.artistName}{song.albumName ? " / " + song.albumName : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </li>
                );
              })}
            </ol>

            {selection.items.length === 0 && (
              <div className="review-complete">
                <span className="tag">[NO TRACKS FOUND]</span>
                <p>No tracks are available to generate.</p>
              </div>
            )}
      </div>

      <div className="step-footer review-footer">
        <div className="selection-count" aria-live="polite">
          <strong>{selected.length.toLocaleString()}</strong>
          <span>TRACK{selected.length === 1 ? "" : "S"}</span>
        </div>
        <button className="action-button step-primary" onClick={generate} disabled={selected.length === 0 || blocksPartialGeneration || Boolean(busy)}>
          {busy === "generate" ? "PREPARING..." : `CONTINUE WITH ${selected.length.toLocaleString()} →`}
        </button>
      </div>
    </section>
  );
}

function ManifestScreen({
  manifest,
  runStatus,
  busy,
  onPublish,
}: {
  manifest: PlaylistManifest;
  runStatus: string;
  busy: boolean;
  onPublish: () => void;
}) {
  const trackCount = manifest.trackCount ?? manifest.tracks.length;
  const volumeCount = manifest.volumeCount ?? Math.max(1, Math.ceil(trackCount / 1000));
  const publishing = ["publishing", "waiting_for_apple_authorization"].includes(runStatus);
  const waitingForApple = runStatus === "waiting_for_apple_authorization";

  return (
    <section className="screen flow-screen manifest-screen" aria-labelledby="manifest-title">
      <div className="flow-body">
        <span className="tag">[{volumeCount} {volumeCount === 1 ? "VOLUME" : "VOLUMES"}]</span>
        <h1 id="manifest-title">{trackCount.toLocaleString()} tracks ready</h1>
        <p>{waitingForApple
          ? "Publication will resume after the owner reconnects Apple Music."
          : publishing || busy
            ? "Creating the playlist in Apple Music."
            : "Review the final count, then publish to Apple Music."}</p>

        <details className="terminal-details manifest-details">
          <summary>PREVIEW TRACK LIST</summary>
          {manifest.tracks.length > 0 ? (
            <ol className="manifest-list">
              {manifest.tracks.slice(0, 8).map((track, index) => (
                <li key={track.candidateId + index}>
                  <span>{String(index + 1).padStart(3, "0")}</span>
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </li>
              ))}
              {trackCount > 8 && <li className="manifest-more">… +{trackCount - 8} TRACKS</li>}
            </ol>
          ) : (
            <div className="empty-state">[TRACK LIST SAVED]</div>
          )}
          {manifest.contentHash && <code className="manifest-hash">SHA256/{manifest.contentHash.slice(0, 20)}…</code>}
        </details>
      </div>

      <div className="step-footer">
        <button className="action-button step-primary" onClick={onPublish} disabled={busy}>
          {waitingForApple
            ? "WAITING FOR APPLE AUTHORIZATION"
            : publishing || busy
              ? "GENERATING PLAYLIST..."
              : "PUBLISH TO APPLE MUSIC →"}
        </button>
      </div>
    </section>
  );
}

function ResultScreen({
  result,
  exploreBusy,
  onReset,
  onRetryUpdatedInterpretation,
  onDelete,
  onExploreVisibility,
}: {
  result: RunResult;
  exploreBusy: boolean;
  onReset: () => void;
  onRetryUpdatedInterpretation: () => void;
  onDelete: () => void;
  onExploreVisibility: (listed: boolean) => void;
}) {
  const outcomes = Object.entries(result.outcomeCounts ?? {});
  const publishedTrackCount = result.volumes.reduce((total, volume) => total + volume.trackCount, 0);
  const hasExactTarget = result.requestedTrackCount !== null
    && result.requestedTrackCount !== undefined;
  const exactTargetSatisfied = hasExactTarget && publishedTrackCount === result.requestedTrackCount;
  const exactTargetMissed = hasExactTarget && !exactTargetSatisfied;
  const knownZeroVisibleGaps = result.unresolvedGapCount === 0;
  const publishedWithGaps = numberValue(result.unresolvedGapCount) > 0
    || exactTargetMissed
    || (result.status === "partial" && !(exactTargetSatisfied && knownZeroVisibleGaps));
  const resultTitle = publishedResultHeading(publishedTrackCount, publishedWithGaps);
  const hasPublishedPlaylist = publishedTrackCount > 0 && result.volumes.length > 0;

  return (
    <section className="screen flow-screen result-screen" aria-labelledby="result-title">
      <div className="flow-body">
        <span className="tag">{hasPublishedPlaylist
          ? `[${result.volumes.length} ${result.volumes.length === 1 ? "VOLUME" : "VOLUMES"}]`
          : "[NO PLAYLIST]"}</span>
        <h1 id="result-title">{resultTitle}</h1>
        <p className="result-track-count">{publishedTrackCountSummary(publishedTrackCount, result.requestedTrackCount)}</p>
        <p className="result-coverage-summary">
          {evidenceCountSummary(numberValue(result.sourceCount), numberValue(result.unresolvedGapCount))}
        </p>
        {hasPublishedPlaylist && <small className="result-note">Apple reports this playlist as public and returned this link. Search, profile visibility, and regional availability are not guaranteed.</small>}

        <div className="volume-list">
          {result.volumes.map((volume) => (
            <article key={volume.index}>
              <span>[{String(volume.index).padStart(2, "0")}]</span>
              <div><strong>{volume.name}</strong><small>{volume.trackCount.toLocaleString()} tracks</small></div>
              {volume.url
                ? <a href={volume.url} target="_blank" rel="noreferrer">OPEN IN APPLE MUSIC ↗</a>
                : <span className="pending-link">LINK PENDING</span>}
            </article>
          ))}
        </div>

        {hasPublishedPlaylist && result.explore && (
          <section className="explore-visibility-card" aria-labelledby="explore-visibility-title">
            <div>
              <span>{result.explore.listed ? "[LISTED]" : "[UNLISTED]"}</span>
              <h2 id="explore-visibility-title">
                {result.explore.listed ? "Visible in Explore" : "Private from Explore"}
              </h2>
              <p>{result.explore.listed
                ? "Anyone with access to gênio can discover this playlist."
                : "The Apple Music link still works, but this playlist is not shown in Explore."}</p>
              {!result.explore.eligible && result.explore.reason && <small>{result.explore.reason}</small>}
            </div>
            {result.explore.canChange && result.explore.eligible && (
              <button
                className="quiet-button"
                type="button"
                onClick={() => onExploreVisibility(!result.explore!.listed)}
                disabled={exploreBusy}
              >
                {exploreBusy
                  ? "SAVING..."
                  : result.explore.listed
                    ? "REMOVE FROM EXPLORE"
                    : "LIST IN EXPLORE"}
              </button>
            )}
          </section>
        )}

        <details className="terminal-details result-details">
          <summary>VIEW COVERAGE REPORT</summary>
          <dl className="result-grid">
            <div><dt>SOURCES</dt><dd>{numberValue(result.sourceCount)}</dd></div>
            <div><dt>OPEN GAPS</dt><dd>{numberValue(result.unresolvedGapCount)}</dd></div>
            {outcomes.slice(0, 4).map(([label, value]) => (
              <div key={label}><dt>{statusLabel(label).toUpperCase()}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </details>
      </div>

      <div className="step-footer result-actions">
        {!hasPublishedPlaylist && (
          <button className="action-button" onClick={onRetryUpdatedInterpretation}>
            RETRY WITH UPDATED INTERPRETATION →
          </button>
        )}
        <button className="quiet-button" onClick={onReset}>← NEW JOB</button>
        {result.evidenceUrl && <a className="quiet-link" href={result.evidenceUrl} target="_blank" rel="noreferrer">VIEW EVIDENCE ↗</a>}
        <button className="text-danger" onClick={onDelete}>DELETE RUN DATA</button>
      </div>
    </section>
  );
}

export function PlaylistBuilder() {
  const [entryStage, setEntryStage] = useState<"command" | "jobs">("command");
  const [introSettled, setIntroSettled] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [trackCount, setTrackCount] = useState(String(PUBLIC_PLAYLIST_DEFAULT_TRACKS));
  const [brief, setBrief] = useState<PlaylistBrief | null>(null);
  const [briefRequestId, setBriefRequestId] = useState<string | null>(null);
  const [guidanceQuestions, setGuidanceQuestions] = useState<GuidedQuestion[]>([]);
  const [guidanceQuestionSetHash, setGuidanceQuestionSetHash] = useState<string | null>(null);
  const [guidanceAnswers, setGuidanceAnswers] = useState<Record<string, GuidedAnswer>>({});
  const [guidanceIndex, setGuidanceIndex] = useState(0);
  const [guidanceSubmission, setGuidanceSubmission] = useState<GuidedAnswer[] | null>(null);
  const [guidanceRecoveryMode, setGuidanceRecoveryMode] =
    useState<GuidanceRecoveryMode | null>(null);
  const [runGuidanceState, setRunGuidanceState] = useState<{
    questionSetHash: string | null;
    answers: Record<string, GuidedAnswer>;
    currentIndex: number;
  }>({
    questionSetHash: null,
    answers: {},
    currentIndex: 0,
  });
  const [guidanceHistory, setGuidanceHistory] =
    useState<GuidanceHistoryView | null>(null);
  const [guidanceRevisionConfirmation, setGuidanceRevisionConfirmation] =
    useState<GuidanceRevisionConfirmation | null>(null);
  const [briefFinalizing, setBriefFinalizing] = useState(false);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [trackSelection, setTrackSelection] = useState<TrackSelection | null>(null);
  const [manifest, setManifest] = useState<PlaylistManifest | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [transferState, setTransferState] = useState("");
  const [jobs, setJobs] = useState<ResearchRun[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const activeRunId = useRef<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const briefIdempotencyKey = useRef<string | null>(null);
  const guidanceIdempotencyKey = useRef<string | null>(null);
  const runGuidanceIdempotencyKey = useRef<{
    questionSetHash: string;
    value: string;
  } | null>(null);
  const guidanceRevisionIdempotencyKey = useRef<string | null>(null);
  const dependencyResumeIdempotencyKey = useRef<{
    decisionHash: string;
    value: string;
  } | null>(null);
  const submittedTrackCountRef = useRef<number | null>(null);
  const publishingRef = useRef(false);
  const matchingRetryAttempted = useRef<Set<string>>(new Set());
  const briefRequestRef = useRef<AbortController | null>(null);
  const tracksRequestRef = useRef<AbortController | null>(null);
  const operationRequestRef = useRef<AbortController | null>(null);
  const restoreStartedRef = useRef(false);
  const settleIntro = useCallback(() => setIntroSettled(true), []);
  const activeRunGuidanceHash = run?.guidanceAction?.questionSetHash ?? null;
  const runGuidanceAnswers = runGuidanceState.questionSetHash === activeRunGuidanceHash
    ? runGuidanceState.answers
    : {};
  const runGuidanceIndex = runGuidanceState.questionSetHash === activeRunGuidanceHash
    ? runGuidanceState.currentIndex
    : 0;

  const deleteAbandonedBrief = useCallback((requestId: string) => {
    void api<void>("/api/v1/brief/" + encodeURIComponent(requestId), {
      method: "DELETE",
    }).catch(() => {
      // This is best-effort cleanup. The server retention sweep remains the
      // fallback when a browser closes or loses connectivity.
    });
  }, []);

  const clearCurrent = useCallback((nextStage: "command" | "jobs") => {
    if (briefRequestId && !run && !manifest && !result) {
      deleteAbandonedBrief(briefRequestId);
    }
    briefRequestRef.current?.abort();
    briefRequestRef.current = null;
    tracksRequestRef.current?.abort();
    tracksRequestRef.current = null;
    operationRequestRef.current?.abort();
    operationRequestRef.current = null;
    setEntryStage(nextStage);
    setPrompt("");
    setTrackCount(String(PUBLIC_PLAYLIST_DEFAULT_TRACKS));
    setBrief(null);
    setBriefRequestId(null);
    setGuidanceQuestions([]);
    setGuidanceQuestionSetHash(null);
    setGuidanceAnswers({});
    setGuidanceIndex(0);
    setGuidanceSubmission(null);
    setGuidanceRecoveryMode(null);
    setRunGuidanceState({
      questionSetHash: null,
      answers: {},
      currentIndex: 0,
    });
    setGuidanceHistory(null);
    setGuidanceRevisionConfirmation(null);
    setBriefFinalizing(false);
    setRun(null);
    activeRunId.current = null;
    setTrackSelection(null);
    setManifest(null);
    setResult(null);
    setBusy("");
    setError("");
    setTransferState("");
    idempotencyKey.current = null;
    briefIdempotencyKey.current = null;
    guidanceIdempotencyKey.current = null;
    runGuidanceIdempotencyKey.current = null;
    guidanceRevisionIdempotencyKey.current = null;
    dependencyResumeIdempotencyKey.current = null;
    submittedTrackCountRef.current = null;
    publishingRef.current = false;
    matchingRetryAttempted.current.clear();
    window.history.replaceState(null, "", window.location.pathname);
  }, [briefRequestId, deleteAbandonedBrief, manifest, result, run]);

  const reset = useCallback(() => clearCurrent("command"), [clearCurrent]);
  const newJob = useCallback(() => clearCurrent("command"), [clearCurrent]);
  const retryWithUpdatedInterpretation = useCallback(() => {
    const retryPrompt = run?.prompt?.trim() || prompt.trim();
    const retryCount = result?.requestedTrackCount
      ?? (run ? partialReadyView(run)?.targetTrackCount : null)
      ?? (run ? exactRequestedTrackCount(run.brief) : null)
      ?? (/^[0-9]+$/u.test(trackCount) ? Number.parseInt(trackCount, 10) : PUBLIC_PLAYLIST_DEFAULT_TRACKS);
    clearCurrent("command");
    setPrompt(retryPrompt);
    setTrackCount(String(retryCount));
    submittedTrackCountRef.current = retryCount;
  }, [clearCurrent, prompt, result?.requestedTrackCount, run, trackCount]);

  const updateRun = useCallback((next: ResearchRun) => {
    if (activeRunId.current !== next.id) return;
    setRun(next);
    if (shouldPresentShortfallWithoutError(next)) setError("");
    else if (next.status === "failed" && next.error) setError(next.error);
  }, []);

  useRunPolling(
    run?.id ?? null,
    run?.status ?? null,
    run?.autoPublish === true,
    Boolean(partialReadyView(run))
      || run?.resolution?.state === "needs_input"
      || run?.resolution?.state === "needs_decision"
      || run?.resolution?.state === "quarantined",
    shouldKeepPollingBlockedRun(run),
    updateRun,
    setError,
  );

  const loadRun = useCallback(async (runId: string, signal?: AbortSignal) => {
    activeRunId.current = runId;
    const next = unwrapRun(await api<ResearchRun | RunResponse>(
      "/api/v1/runs/" + encodeURIComponent(runId),
      { signal },
    ));
    if (signal?.aborted) return;
    if (activeRunId.current !== runId) return;
    activeRunId.current = next.id;
    setRun(next);
    setBrief(next.brief);
    setPrompt(next.prompt);
    if (shouldPresentShortfallWithoutError(next)) setError("");
    const requestedCount = exactRequestedTrackCount(next.brief);
    if (requestedCount) setTrackCount(String(requestedCount));
  }, []);

  const openJobs = useCallback(async () => {
    clearCurrent("jobs");
    const query = new URLSearchParams();
    query.set("view", "jobs");
    window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
    setJobsLoading(true);
    try {
      const payload = await api<{ items?: ResearchRun[] }>("/api/v1/runs");
      setJobs(Array.isArray(payload.items) ? payload.items : []);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setJobs([]);
      else setError((caught as Error).message);
    } finally {
      setJobsLoading(false);
    }
  }, [clearCurrent]);

  const openJob = useCallback(async (runId: string) => {
    clearCurrent("command");
    setBusy("open-job");
    try {
      const query = new URLSearchParams();
      query.set("run", runId);
      window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
      await loadRun(runId);
    } catch (caught) {
      setError((caught as Error).message);
      setEntryStage("jobs");
    } finally {
      setBusy("");
    }
  }, [clearCurrent, loadRun]);

  const exchangeCapability = useCallback(async (token: string, hintedRunId?: string | null, signal?: AbortSignal) => {
    const payload = await api<JsonObject>("/api/v1/capabilities/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
      signal,
    });
    if (signal?.aborted) return;
    const runId = typeof payload.runId === "string"
      ? payload.runId
      : typeof payload.id === "string"
        ? payload.id
        : hintedRunId;
    if (runId) {
      const query = new URLSearchParams();
      query.set("run", runId);
      window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
      await loadRun(runId, signal);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [loadRun]);

  const startResearchFromBrief = useCallback(async (
    nextBrief: PlaylistBrief,
    nextBriefRequestId: string,
    expectedTrackCount: number,
    signal?: AbortSignal,
  ) => {
    assertExactBriefTrackCount(nextBrief, expectedTrackCount);
    if (!idempotencyKey.current) idempotencyKey.current = "run-" + nextBriefRequestId;
    const response = await api<ResearchRun | RunResponse>("/api/v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey.current },
      body: JSON.stringify({
        briefRequestId: nextBriefRequestId,
        brief: nextBrief,
        targetTrackCount: expectedTrackCount,
      }),
      signal,
    });
    if (signal?.aborted) return;
    const next = unwrapRun(response);
    const object = asObject(response);
    const capability = typeof object.capability === "string"
      ? object.capability
      : typeof object.capabilityToken === "string"
        ? object.capabilityToken
        : "";
    if (!capability) throw new Error("gênio could not establish a private session for this run.");
    const fragment = "cap=" + encodeURIComponent(capability) + "&run=" + encodeURIComponent(next.id);
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#" + fragment);
    await exchangeCapability(capability, next.id, signal);
    if (signal?.aborted) return;
    idempotencyKey.current = null;
    briefIdempotencyKey.current = null;
  }, [exchangeCapability]);

  const adoptAuthoritativeBrief = useCallback((
    response: Pick<BriefResponse, "brief" | "requestedTrackCount">,
    fallbackBrief?: PlaylistBrief | null,
  ): { brief: PlaylistBrief; requestedTrackCount: number } | null => {
    const nextBrief = response.brief ?? fallbackBrief ?? null;
    if (!nextBrief) return null;
    const requestedTrackCount = exactRequestedTrackCount(nextBrief);
    if (requestedTrackCount === null
      || (
        response.requestedTrackCount != null
        && response.requestedTrackCount !== requestedTrackCount
      )) {
      return null;
    }
    setBrief(nextBrief);
    setTrackCount(String(requestedTrackCount));
    submittedTrackCountRef.current = requestedTrackCount;
    return { brief: nextBrief, requestedTrackCount };
  }, []);

  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const restore = async () => {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const rawHash = window.location.hash.replace(/^#/, "");
      const token = params.get("cap") || params.get("capability") || (!rawHash.includes("=") ? rawHash : "");
      const search = new URLSearchParams(window.location.search);
      const runId = params.get("run") || search.get("run");
      const queuedBriefId = search.get("brief");
      try {
        if (token) await exchangeCapability(token, runId);
        else if (runId) await loadRun(runId);
        else if (search.get("view") === "jobs") await openJobs();
        else if (queuedBriefId) {
          setBriefRequestId(queuedBriefId);
          setBriefFinalizing(true);
          const response = await waitForBrief(queuedBriefId);
          const restored = adoptAuthoritativeBrief(response);
          if (!restored) throw new Error("The playlist request could not be restored.");
          setPrompt(response.prompt ?? "");
          setBriefRequestId(queuedBriefId);
          if (response.status === "awaiting_answers" && response.questions?.length) {
            setGuidanceQuestions(response.questions);
            setGuidanceQuestionSetHash(response.questionSetHash ?? null);
            setGuidanceAnswers({});
            setGuidanceIndex(0);
            setGuidanceSubmission(null);
            setGuidanceRecoveryMode(null);
            setBriefFinalizing(false);
          } else {
            await startResearchFromBrief(
              restored.brief,
              queuedBriefId,
              restored.requestedTrackCount,
            );
          }
        }
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        const quietRunReset = shouldQuietlyClearInitialRunRestore({
          hasRunId: Boolean(runId),
          status,
          code: caught instanceof ApiError ? caught.code : null,
        });
        if (quietRunReset) {
          activeRunId.current = null;
          setEntryStage("command");
          setRun(null);
          setBrief(null);
          setPrompt("");
          setTrackCount(String(PUBLIC_PLAYLIST_DEFAULT_TRACKS));
          setTrackSelection(null);
          setManifest(null);
          setResult(null);
          setBusy("");
          setError("");
          window.history.replaceState(null, "", window.location.pathname);
        } else {
          setError((caught as Error).message);
          if ([400, 401, 404, 410].includes(status)) {
            window.history.replaceState(null, "", window.location.pathname);
          }
        }
      } finally {
        setBriefFinalizing(false);
        setRestoring(false);
      }
    };
    void restore();
  }, [
    adoptAuthoritativeBrief,
    exchangeCapability,
    loadRun,
    openJobs,
    startResearchFromBrief,
  ]);

  const loadTracks = useCallback(async () => {
    if (!run) return;
    const runId = run.id;
    tracksRequestRef.current?.abort();
    const controller = new AbortController();
    tracksRequestRef.current = controller;
    setBusy("tracks");
    try {
      const normalizedFirst = normalizeTrackSelection(
        await api<unknown>(
          "/api/v1/runs/" + encodeURIComponent(runId) + "/tracks?page=1&pageSize=500",
          { signal: controller.signal },
        ),
        1,
      );
      // The run brief is already confirmed and durable. Use it as the final
      // guard when an older gateway or stringly JSON response omits the exact
      // requested count, so the browser can never offer a silent partial
      // playlist while the server rejects it.
      const first: TrackSelection = {
        ...normalizedFirst,
        requestedTrackCount: normalizedFirst.requestedTrackCount
          ?? exactRequestedTrackCount(run.brief),
      };
      const pagesLoaded = [first];
      for (let start = 2; start <= first.totalPages; start += 5) {
        const pages = await Promise.all(
          Array.from(
            { length: Math.min(5, first.totalPages - start + 1) },
            (_, index) => start + index,
          ).map(async (pageNumber) => normalizeTrackSelection(
            await api<unknown>(
              "/api/v1/runs/" + encodeURIComponent(runId) + "/tracks?page=" + pageNumber + "&pageSize=500",
              { signal: controller.signal },
            ),
            pageNumber,
          )),
        );
        pagesLoaded.push(...pages);
      }
      if (activeRunId.current !== runId) return;

      const inconsistentPage = pagesLoaded.find((page) => (
        page.total !== first.total
        || page.totalPages !== first.totalPages
        || page.page < 1
        || page.page > Math.max(1, first.totalPages)
      ));
      if (inconsistentPage) {
        throw new Error("The track list changed while loading. Retry this job before generating the playlist.");
      }

      const items = pagesLoaded.flatMap((page) => page.items);
      const candidateIds = new Set<string>();
      for (const item of items) {
        if (!item.candidateId || candidateIds.has(item.candidateId)) {
          throw new Error("The track list is incomplete. Retry this job before generating the playlist.");
        }
        candidateIds.add(item.candidateId);
      }
      if (items.length !== first.total) {
        throw new Error(`The track list is incomplete (${items.length.toLocaleString()} of ${first.total.toLocaleString()} loaded). Retry this job before generating the playlist.`);
      }

      items.sort((left, right) => left.position - right.position || left.candidateId.localeCompare(right.candidateId));
      if (first.retryableCount > 0 && !matchingRetryAttempted.current.has(runId)) {
        setBusy("matching");
        try {
          const response = await api<JsonObject>("/api/v1/runs/" + encodeURIComponent(runId) + "/matching", {
            method: "POST",
            headers: { "Idempotency-Key": "matching-" + runId },
            body: "{}",
            signal: controller.signal,
          });
          if (activeRunId.current !== runId) return;
          matchingRetryAttempted.current.add(runId);
          setTrackSelection(null);
          setRun(unwrapRun(response as RunResponse));
          return;
        } catch (caught) {
          if (isAbortError(caught) || activeRunId.current !== runId) return;
          setTrackSelection({ ...first, items, page: 1, pageSize: items.length, totalPages: 1 });
          throw caught;
        }
      }
      setTrackSelection({ ...first, items, page: 1, pageSize: items.length, totalPages: 1 });
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (tracksRequestRef.current === controller) {
        tracksRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }, [run]);

  useEffect(() => {
    if (!run || run.autoPublish || !reviewStatuses.has(run.status)) return;
    const timer = window.setTimeout(() => void loadTracks(), 0);
    return () => window.clearTimeout(timer);
  }, [run, loadTracks]);

  useEffect(() => {
    if (!run || run.autoPublish || run.status !== "manifest_ready" || manifest) return;
    void (async () => {
      try {
        const payload = await api<unknown>("/api/v1/runs/" + encodeURIComponent(run.id) + "/result");
        const storedManifest = manifestFromResult(payload, run.id);
        if (!storedManifest) throw new Error("The playlist details could not be restored.");
        setManifest(storedManifest);
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }, [run, manifest]);

  useEffect(() => {
    if (!run || partialReadyView(run) || !["complete", "partial"].includes(run.status) || result) return;
    void (async () => {
      try {
        setResult(unwrapResult(
          await api<RunResult | { result: RunResult } | JsonObject>(
            "/api/v1/runs/" + encodeURIComponent(run.id) + "/result",
          ),
          run,
        ));
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }, [run, result]);

  async function createPlaylist(submission?: PlaylistCommandSubmission) {
    const submittedPrompt = (submission?.prompt ?? prompt).trim();
    const submittedTrackCount = submission?.trackCount ?? trackCount;
    const requestedTrackCount = /^[0-9]+$/u.test(submittedTrackCount)
      ? Number.parseInt(submittedTrackCount, 10)
      : Number.NaN;
    if (submittedPrompt.length < 4
      || !Number.isInteger(requestedTrackCount)
      || requestedTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
      || requestedTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS) return;
    setPrompt(submittedPrompt);
    setTrackCount(String(requestedTrackCount));
    submittedTrackCountRef.current = requestedTrackCount;
    briefRequestRef.current?.abort();
    const controller = new AbortController();
    briefRequestRef.current = controller;
    setBusy("create");
    setError("");
    try {
      if (brief && briefRequestId) {
        assertExactBriefTrackCount(brief, requestedTrackCount);
        setBriefFinalizing(true);
        await startResearchFromBrief(brief, briefRequestId, requestedTrackCount, controller.signal);
        return;
      }
      if (!briefIdempotencyKey.current) briefIdempotencyKey.current = crypto.randomUUID();
      let response = await api<BriefResponse>("/api/v1/brief", {
        method: "POST",
        headers: { "Idempotency-Key": briefIdempotencyKey.current },
        body: JSON.stringify({
          prompt: submittedPrompt,
          targetTrackCount: requestedTrackCount,
          idempotencyKey: briefIdempotencyKey.current,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const initialRequestId = response.requestId;
      if (initialRequestId) {
        setBriefRequestId(initialRequestId);
        const query = new URLSearchParams();
        query.set("brief", initialRequestId);
        window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
      }
      if (
        initialRequestId
        && !response.brief
        && !(response.status === "awaiting_answers" && response.questions?.length)
      ) {
        setBriefFinalizing(true);
        response = await waitForBrief(initialRequestId, numberValue(response.pollAfterMs, 1_500), controller.signal);
      }
      if (controller.signal.aborted) return;
      if (!response.brief) throw new Error("Scope interpretation is taking longer than expected. Retry with the same request.");
      assertExactBriefTrackCount(response.brief, requestedTrackCount);
      const adopted = adoptAuthoritativeBrief(response);
      if (!adopted) {
        throw new Error("The playlist size could not be restored. Return to the request and choose it again.");
      }
      const requestId = response.requestId ?? initialRequestId;
      if (!requestId) throw new Error("gênio could not resume this playlist request.");
      setBriefRequestId(requestId);
      if (response.status === "awaiting_answers" && response.questions?.length) {
        setGuidanceQuestions(response.questions);
        setGuidanceQuestionSetHash(response.questionSetHash ?? null);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode(null);
        setBriefFinalizing(false);
      } else {
        setBriefFinalizing(true);
        await startResearchFromBrief(
          adopted.brief,
          requestId,
          adopted.requestedTrackCount,
          controller.signal,
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (caught instanceof BriefInterpretationError) briefIdempotencyKey.current = null;
      setError((caught as Error).message);
    } finally {
      if (briefRequestRef.current === controller) {
        briefRequestRef.current = null;
        setBriefFinalizing(false);
        setBusy("");
      }
    }
  }

  function editPlaylistRequest() {
    briefRequestRef.current?.abort();
    briefRequestRef.current = null;
    if (briefRequestId && !run && !manifest && !result) {
      deleteAbandonedBrief(briefRequestId);
    }
    setGuidanceQuestions([]);
    setGuidanceQuestionSetHash(null);
    setGuidanceAnswers({});
    setGuidanceIndex(0);
    setGuidanceSubmission(null);
    setGuidanceRecoveryMode(null);
    setBriefFinalizing(false);
    setBrief(null);
    setBriefRequestId(null);
    setBusy("");
    setError("");
    briefIdempotencyKey.current = null;
    guidanceIdempotencyKey.current = null;
    idempotencyKey.current = null;
    window.history.replaceState(null, "", window.location.pathname);
  }

  function answerGuidance(answer: GuidedAnswer) {
    if (guidanceSubmission) return;
    setError("");
    setGuidanceAnswers((current) => ({ ...current, [answer.questionId]: answer }));
  }

  function editGuidanceArtist() {
    setGuidanceSubmission(null);
    setGuidanceRecoveryMode("edit_artist");
    setBriefFinalizing(false);
    guidanceIdempotencyKey.current = null;
  }

  async function continueGuidance() {
    const question = guidanceQuestions[guidanceIndex];
    if (!question || !briefRequestId) return;
    const answer = guidanceAnswers[question.id];
    if (!answer?.optionId
      && !answer?.optionIds?.length
      && !answer?.customText?.trim()
      && !answer?.skipped) return;
    if (guidanceIndex < guidanceQuestions.length - 1) {
      setGuidanceIndex((current) => Math.min(guidanceQuestions.length - 1, current + 1));
      return;
    }

    const answers = guidanceSubmission
      ?? guidanceQuestions.map((item) => guidanceAnswers[item.id]).filter(Boolean);
    if (answers.length !== guidanceQuestions.length) return;
    if (!guidanceSubmission) {
      setGuidanceSubmission(answers.map((item) => ({ ...item })));
    }
    if (!guidanceIdempotencyKey.current) guidanceIdempotencyKey.current = crypto.randomUUID();
    setGuidanceRecoveryMode(null);

    briefRequestRef.current?.abort();
    const controller = new AbortController();
    briefRequestRef.current = controller;
    setBusy("guidance");
    setBriefFinalizing(true);
    setError("");
    try {
      const response = await api<BriefResponse>(
        "/api/v1/brief/" + encodeURIComponent(briefRequestId) + "/answers",
        {
          method: "POST",
          headers: { "Idempotency-Key": guidanceIdempotencyKey.current },
          body: JSON.stringify({
            answers,
            questionSetHash: guidanceQuestionSetHash,
            idempotencyKey: guidanceIdempotencyKey.current,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (response.status === "failed") {
        throw new BriefInterpretationError(response.error || "The playlist request could not be finalized.");
      }
      if (response.status === "awaiting_answers" && response.questions?.length) {
        if (response.brief && !adoptAuthoritativeBrief(response)) {
          throw new Error("The playlist size could not be restored. Return to the request and choose it again.");
        }
        setGuidanceQuestions(response.questions);
        setGuidanceQuestionSetHash(response.questionSetHash ?? null);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode(null);
        setBriefFinalizing(false);
        guidanceIdempotencyKey.current = null;
        return;
      }

      const finalized = await waitForBrief(
        briefRequestId,
        numberValue(response.pollAfterMs, 1_500),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (finalized.status === "awaiting_answers" && finalized.questions?.length) {
        if (!adoptAuthoritativeBrief(finalized, brief)) {
          throw new Error("The playlist size could not be restored. Return to the request and choose it again.");
        }
        setGuidanceQuestions(finalized.questions);
        setGuidanceQuestionSetHash(finalized.questionSetHash ?? null);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode(null);
        setBriefFinalizing(false);
        guidanceIdempotencyKey.current = null;
        return;
      }
      const adopted = adoptAuthoritativeBrief(finalized);
      if (!adopted) {
        throw new Error("The playlist size could not be restored. Return to the request and choose it again.");
      }
      await startResearchFromBrief(
        adopted.brief,
        briefRequestId,
        adopted.requestedTrackCount,
        controller.signal,
      );
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (
        caught instanceof ApiError
        && caught.code === "exact_artist_identity_clarification_required"
      ) {
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode("edit_artist");
        guidanceIdempotencyKey.current = null;
        setBriefFinalizing(false);
        setError(caught.message);
        return;
      }
      if (
        caught instanceof ApiError
        && caught.code === "artist_identity_resolution_retryable"
      ) {
        // Preserve the exact answer snapshot and idempotency key so Retry
        // lookup is the same bounded request. Editing explicitly creates a new
        // request identity through editGuidanceArtist().
        setGuidanceRecoveryMode("retry_lookup");
        setBriefFinalizing(false);
        setError(caught.message);
        return;
      }
      if (
        caught instanceof ApiError
        && caught.code === "artist_identity_resolution_configuration"
      ) {
        // Operator-side catalog configuration is not retryable with the same
        // request. Keep the brief and custom text editable so the visitor can
        // remove or change the exact-artist rule without starting over.
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode("configuration");
        guidanceIdempotencyKey.current = null;
        setBriefFinalizing(false);
        setError(caught.message);
        return;
      }
      if (caught instanceof ApiError && caught.code === "stale_guidance_question_set") {
        const current = await api<BriefResponse>(
          "/api/v1/brief/" + encodeURIComponent(briefRequestId),
          { signal: controller.signal },
        );
        if (!adoptAuthoritativeBrief(current, brief)) {
          setGuidanceSubmission(null);
          setGuidanceRecoveryMode(null);
          guidanceIdempotencyKey.current = null;
          setBriefFinalizing(false);
          setError("The playlist size could not be restored. Return to the request and choose it again.");
          return;
        }
        setGuidanceQuestions(current.questions ?? []);
        setGuidanceQuestionSetHash(current.questionSetHash ?? null);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setGuidanceRecoveryMode(null);
        guidanceIdempotencyKey.current = null;
        setBriefFinalizing(false);
        setError("The guidance changed while you were answering. Review the current questions and try again.");
        return;
      }
      setBriefFinalizing(false);
      setError((caught as Error).message);
    } finally {
      if (briefRequestRef.current === controller) {
        briefRequestRef.current = null;
        setBusy("");
      }
    }
  }

  async function retryMatching() {
    if (!run || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("matching");
    setError("");
    try {
      const response = await api<JsonObject>("/api/v1/runs/" + encodeURIComponent(runId) + "/matching", {
        method: "POST",
        headers: { "Idempotency-Key": "matching-" + runId },
        body: "{}",
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      const next = unwrapRun(response as RunResponse);
      matchingRetryAttempted.current.add(runId);
      setTrackSelection(null);
      setRun(next);
      if (reviewStatuses.has(next.status)) await loadTracks();
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function generatePlaylist(selection: TrackSelectionRequest) {
    if (!run || publishingRef.current || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    publishingRef.current = true;
    setBusy("generate");
    setError("");
    try {
      const nextManifest = unwrapManifest(await api<PlaylistManifest | { manifest: PlaylistManifest }>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/selection",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(selection),
          signal: controller.signal,
        },
      ));
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      setManifest(nextManifest);
      const response = await api<ResearchRun | RunResponse>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/publish",
        {
          method: "POST",
          headers: { "Idempotency-Key": "publish-" + nextManifest.id },
          body: JSON.stringify({ manifestId: nextManifest.id }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      setRun(unwrapRun(response));
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        publishingRef.current = false;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function publish() {
    if (!run || !manifest || publishingRef.current || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    publishingRef.current = true;
    setBusy("publish");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/publish",
        {
          method: "POST",
          headers: { "Idempotency-Key": "publish-" + manifest.id },
          body: JSON.stringify({ manifestId: manifest.id }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      setRun(unwrapRun(response));
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        publishingRef.current = false;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  function answerRunGuidance(answer: GuidedAnswer) {
    const questionSetHash = run?.guidanceAction?.questionSetHash;
    if (!questionSetHash) return;
    setRunGuidanceState((current) => ({
      questionSetHash,
      answers: {
        ...(current.questionSetHash === questionSetHash ? current.answers : {}),
        [answer.questionId]: answer,
      },
      currentIndex: current.questionSetHash === questionSetHash
        ? current.currentIndex
        : 0,
    }));
  }

  async function continueRunGuidance(explicitAnswers?: GuidedAnswer[]) {
    const action = run?.guidanceAction;
    if (!run || !action || action.kind !== "rescue_guidance"
      || operationRequestRef.current) return;
    const question = action.questions[runGuidanceIndex];
    if (!question) return;
    if (!explicitAnswers && runGuidanceIndex < action.questions.length - 1) {
      setRunGuidanceState((current) => ({
        questionSetHash: action.questionSetHash,
        answers: current.questionSetHash === action.questionSetHash
          ? current.answers
          : {},
        currentIndex: Math.min(
          action.questions.length - 1,
          current.questionSetHash === action.questionSetHash
            ? current.currentIndex + 1
            : 1,
        ),
      }));
      return;
    }
    const answers = explicitAnswers
      ?? action.questions.map((item) => runGuidanceAnswers[item.id]).filter(Boolean);
    if (answers.length !== action.questions.length) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    if (runGuidanceIdempotencyKey.current?.questionSetHash !== action.questionSetHash) {
      runGuidanceIdempotencyKey.current = {
        questionSetHash: action.questionSetHash,
        value: crypto.randomUUID(),
      };
    }
    const guidanceRequestKey = runGuidanceIdempotencyKey.current.value;
    setBusy("run-guidance");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/guidance/answers",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": guidanceRequestKey,
          },
          body: JSON.stringify({
            questionSetHash: action.questionSetHash,
            answers,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      const next = unwrapRun(response);
      activeRunId.current = next.id;
      setRun(next);
      setBrief(next.brief);
      setPrompt(next.prompt);
      setRunGuidanceState({
        questionSetHash: null,
        answers: {},
        currentIndex: 0,
      });
      runGuidanceIdempotencyKey.current = null;
      const query = new URLSearchParams();
      query.set("run", next.id);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + "?" + query.toString(),
      );
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) {
        setError((caught as Error).message);
      }
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        setBusy("");
      }
    }
  }

  async function openGuidanceHistory() {
    if (!run || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("guidance-history");
    setError("");
    try {
      const history = await api<GuidanceHistoryView>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/guidance/history",
        { signal: controller.signal },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      guidanceRevisionIdempotencyKey.current = null;
      setGuidanceRevisionConfirmation(null);
      setGuidanceHistory(history);
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) {
        setError((caught as Error).message);
      }
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        setBusy("");
      }
    }
  }

  async function reviseGuidanceAnswer(
    item: GuidanceHistoryItem,
    answer: GuidedAnswer,
    confirmationHash?: string,
  ) {
    if (!run || !guidanceHistory || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    if (!confirmationHash || !guidanceRevisionIdempotencyKey.current) {
      guidanceRevisionIdempotencyKey.current = crypto.randomUUID();
    }
    setBusy("guidance-revision");
    setError("");
    try {
      const response = await api<
        | {
            status: "needs_confirmation";
            confirmationHash: string;
            interpretationSummary:
              GuidanceRevisionConfirmation["interpretationSummary"];
            hardChangeReasons: string[];
          }
        | { status: "revised"; run: ResearchRun }
      >(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/guidance/revisions",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": guidanceRevisionIdempotencyKey.current,
          },
          body: JSON.stringify({
            answerSetId: item.answerSetId,
            questionId: item.question.id,
            answer,
            expectedContractRevisionId:
              guidanceHistory.activeContractRevisionId,
            expectedContractSemanticHash:
              guidanceHistory.activeContractSemanticHash,
            historyVersion: guidanceHistory.historyVersion,
            ...(confirmationHash ? {
              confirmationHash,
              confirmed: true,
            } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      if (response.status === "needs_confirmation") {
        setGuidanceRevisionConfirmation({
          item,
          answer,
          confirmationHash: response.confirmationHash,
          interpretationSummary: response.interpretationSummary,
          hardChangeReasons: response.hardChangeReasons,
        });
        return;
      }
      const next = response.run;
      activeRunId.current = next.id;
      setRun(next);
      setBrief(next.brief);
      setPrompt(next.prompt);
      setGuidanceHistory(null);
      setGuidanceRevisionConfirmation(null);
      guidanceRevisionIdempotencyKey.current = null;
      const query = new URLSearchParams();
      query.set("run", next.id);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + "?" + query.toString(),
      );
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) {
        setError((caught as Error).message);
      }
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        setBusy("");
      }
    }
  }

  async function continuePartialResearch() {
    if (!run || operationRequestRef.current) return;
    const decision = partialReadyView(run);
    if (!decision?.canContinueResearch) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("continue-research");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/research/continue",
        {
          method: "POST",
          headers: { "Idempotency-Key": `continue-${runId}-${decision.outcomeVersion ?? "current"}` },
          body: JSON.stringify({
            outcomeVersion: decision.outcomeVersion,
            ...(run.decisionAction?.decisionHash
              ? { decisionHash: run.decisionAction.decisionHash }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      setRun(unwrapRun(response));
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function resumeDependencyResearch() {
    if (!run || operationRequestRef.current) return;
    const decision = run.decisionAction;
    const resolution = run.resolution;
    const blocker = resolution?.blocker;
    const eligible = run.status === "needs_decision"
      && run.phase === "dependency_retry_window_expired"
      && resolution?.state === "needs_decision"
      && resolution.nextAction === "resume_research"
      && blocker?.kind === "provider"
      && typeof blocker.versionHash === "string"
      && /^[a-f0-9]{64}$/u.test(blocker.versionHash)
      && typeof resolution.contractRevisionId === "string"
      && typeof resolution.contractHash === "string"
      && /^[a-f0-9]{64}$/u.test(resolution.contractHash)
      && decision?.reason === "dependency_retry_window_expired"
      && decision.actions.resumeLater === true
      && /^[a-f0-9]{64}$/u.test(decision.decisionHash);
    if (!eligible || !decision || !resolution || !blocker?.versionHash
      || !resolution.contractRevisionId || !resolution.contractHash) {
      setError("This dependency resume option is no longer current. Refresh the job before continuing.");
      return;
    }
    if (dependencyResumeIdempotencyKey.current?.decisionHash
      !== decision.decisionHash) {
      dependencyResumeIdempotencyKey.current = {
        decisionHash: decision.decisionHash,
        value: `dependency-resume-${crypto.randomUUID()}`,
      };
    }
    const key = dependencyResumeIdempotencyKey.current.value;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("resume-dependency");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse>(
        `/api/v1/runs/${encodeURIComponent(runId)}/dependency/resume`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({
            expectedContractRevisionId:
              resolution.contractRevisionId,
            expectedContractSemanticHash: resolution.contractHash,
            decisionHash: decision.decisionHash,
            blockerVersion: blocker.versionHash,
            idempotencyKey: key,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      dependencyResumeIdempotencyKey.current = null;
      setRun(unwrapRun(response));
    } catch (caught) {
      if (isAbortError(caught) || activeRunId.current !== runId) return;
      const conflict = caught instanceof ApiError && [
        "dependency_resume_stale",
        "dependency_resume_conflict",
        "dependency_resume_cancelled",
        "dependency_resume_quarantined",
        "dependency_resume_contract_conflict",
        "dependency_resume_executor_conflict",
      ].includes(caught.code ?? "");
      setError(conflict
        ? `${caught.message} Refresh the job to review its current state.`
        : (caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function publishPartialPlaylist() {
    if (!run || operationRequestRef.current || publishingRef.current) return;
    const decision = partialReadyView(run);
    if (!decision || decision.qualifiedTrackCount <= 0) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    publishingRef.current = true;
    setBusy("publish-partial");
    setError("");
    try {
      const response = await api<JsonObject>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/partial/confirm",
        {
          method: "POST",
          headers: { "Idempotency-Key": `partial-${runId}-${decision.outcomeVersion ?? "current"}` },
          body: JSON.stringify({
            outcomeHash: decision.outcomeHash,
            manifestId: decision.manifestId,
            manifestHash: decision.manifestHash,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      const responseObject = asObject(response);
      const nextRunObject = asObject(responseObject.run);
      if (typeof nextRunObject.id === "string") setRun(nextRunObject as ResearchRun);

      const manifestObject = asObject(responseObject.manifest);
      if (typeof manifestObject.id === "string") {
        const nextManifest = manifestObject as PlaylistManifest;
        setManifest(nextManifest);
        const nextStatus = typeof nextRunObject.status === "string" ? nextRunObject.status : "";
        if (!["publishing", "waiting_for_apple_authorization", "complete", "partial"].includes(nextStatus)) {
          const publishResponse = await api<ResearchRun | RunResponse>(
            "/api/v1/runs/" + encodeURIComponent(runId) + "/publish",
            {
              method: "POST",
              headers: { "Idempotency-Key": "publish-" + nextManifest.id },
              body: JSON.stringify({ manifestId: nextManifest.id }),
              signal: controller.signal,
            },
          );
          if (!controller.signal.aborted && activeRunId.current === runId) setRun(unwrapRun(publishResponse));
        }
      }
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        publishingRef.current = false;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function cancelRun() {
    if (!run || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("cancel-run");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse | JsonObject>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/cancel",
        {
          method: "POST",
          headers: { "Idempotency-Key": "cancel-" + runId },
          body: "{}",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      const object = asObject(response);
      if (object.run || typeof object.id === "string") setRun(unwrapRun(response as ResearchRun | RunResponse));
      else newJob();
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function updateExploreVisibility(listed: boolean) {
    if (!run || !result || operationRequestRef.current) return;
    const runId = run.id;
    const controller = new AbortController();
    operationRequestRef.current = controller;
    setBusy("explore-visibility");
    setError("");
    try {
      const response = await api<JsonObject>(
        "/api/v1/runs/" + encodeURIComponent(runId) + "/explore",
        {
          method: "POST",
          headers: { "Idempotency-Key": `explore-${runId}-${listed ? "listed" : "unlisted"}` },
          body: JSON.stringify({ listed }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || activeRunId.current !== runId) return;
      const nextExplore = resultExploreSettings(response.explore, response);
      setResult((current) => current ? {
        ...current,
        explore: nextExplore ?? (current.explore ? { ...current.explore, listed } : null),
      } : current);
    } catch (caught) {
      if (!isAbortError(caught) && activeRunId.current === runId) setError((caught as Error).message);
    } finally {
      if (operationRequestRef.current === controller) {
        operationRequestRef.current = null;
        if (activeRunId.current === runId) setBusy("");
      }
    }
  }

  async function deleteRun() {
    if (!run || !window.confirm("Delete this run’s research data from gênio? Published Apple playlists will remain.")) return;
    setBusy("delete");
    try {
      await api("/api/v1/runs/" + encodeURIComponent(run.id), { method: "DELETE" });
      reset();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function transferRun() {
    if (!run) return;
    setTransferState("busy");
    setError("");
    try {
      const payload = await api<JsonObject>(
        "/api/v1/runs/" + encodeURIComponent(run.id) + "/capabilities/transfer",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
        },
      );
      const capability = typeof payload.capability === "string"
        ? payload.capability
        : typeof payload.token === "string"
          ? payload.token
          : "";
      if (!capability) throw new Error("gênio did not return a transfer capability.");
      const url = new URL(window.location.pathname, window.location.origin);
      url.hash = "cap=" + encodeURIComponent(capability) + "&run=" + encodeURIComponent(run.id);
      await copyText(url.toString());
      setTransferState("copied");
      window.setTimeout(() => setTransferState(""), 3000);
    } catch (caught) {
      setError((caught as Error).message);
      setTransferState("");
    }
  }

  const partialDecision = partialReadyView(run);

  if (restoring) {
    return (
      <main className="app-shell">
        <AppHeader onHome={reset} onJobs={() => void openJobs()} />
        <section className="screen restore-screen" role="status">
          <span className="cursor" aria-hidden="true">▋</span>RESTORING RUN
        </section>
      </main>
    );
  }

  if (!run && !manifest && !result && entryStage === "command" && briefFinalizing) {
    return (
      <main className="app-shell one-command-shell guided-shell">
        <AppHeader onHome={reset} onJobs={() => void openJobs()} />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <FinalizingBriefScreen />
      </main>
    );
  }

  if (!run && !manifest && !result && entryStage === "command" && guidanceQuestions.length > 0) {
    return (
      <main className="app-shell one-command-shell guided-shell">
        <AppHeader onHome={reset} onJobs={() => void openJobs()} />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <GuidedQuestionScreen
          questions={guidanceQuestions}
          currentIndex={guidanceIndex}
          answers={guidanceAnswers}
          busy={Boolean(busy)}
          locked={guidanceSubmission !== null}
          recoveryMode={guidanceRecoveryMode}
          onAnswer={answerGuidance}
          onEditArtist={editGuidanceArtist}
          onBack={() => {
            if (guidanceSubmission || guidanceIndex === 0) editPlaylistRequest();
            else setGuidanceIndex((current) => Math.max(0, current - 1));
          }}
          onNext={() => void continueGuidance()}
        />
      </main>
    );
  }

  if (!run && !manifest && !result && entryStage === "command") {
    return (
      <main className="app-shell one-command-shell">
        <BrandIntro onSettled={settleIntro} />
        <AppHeader onHome={reset} onJobs={() => void openJobs()} />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <OneCommandScreen
          prompt={prompt}
          trackCount={trackCount}
          busy={busy}
          introSettled={introSettled}
          onPrompt={(value) => {
            setPrompt(value);
            setBrief(null);
            setBriefRequestId(null);
            briefIdempotencyKey.current = null;
            idempotencyKey.current = null;
            submittedTrackCountRef.current = null;
          }}
          onTrackCount={(value) => {
            setTrackCount(value);
            setBrief(null);
            setBriefRequestId(null);
            briefIdempotencyKey.current = null;
            idempotencyKey.current = null;
            submittedTrackCountRef.current = null;
          }}
          onSubmit={(submission) => void createPlaylist(submission)}
        />
      </main>
    );
  }

  if (!brief && !run && !manifest && !result && entryStage === "jobs") {
    return (
      <main className="app-shell">
        <AppHeader
          onHome={reset}
          onJobs={() => void openJobs()}
          active="jobs"
        />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <JobsScreen
          jobs={jobs}
          loading={jobsLoading}
          onBack={reset}
          onNew={newJob}
          onOpen={(runId) => void openJob(runId)}
        />
      </main>
    );
  }

  if (run && guidanceHistory && !manifest && !result) {
    return (
      <main className="app-shell one-command-shell guided-shell">
        <AppHeader
          transferState={transferState}
          onTransfer={transferRun}
          onHome={reset}
          onJobs={() => void openJobs()}
          active="jobs"
        />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <GuidanceHistoryScreen
          history={guidanceHistory}
          busy={busy === "guidance-revision"}
          confirmation={guidanceRevisionConfirmation}
          onBack={() => {
            setGuidanceRevisionConfirmation(null);
            setGuidanceHistory(null);
            guidanceRevisionIdempotencyKey.current = null;
          }}
          onRevise={(item, answer, confirmationHash) => {
            void reviseGuidanceAnswer(item, answer, confirmationHash);
          }}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      {(run || manifest || result) && (
        <AppHeader
          transferState={transferState}
          onTransfer={run ? transferRun : undefined}
          onHome={reset}
          onJobs={() => void openJobs()}
          active="jobs"
        />
      )}
      <ErrorBar message={run && shouldPresentShortfallWithoutError(run) ? "" : error} onDismiss={() => setError("")} />

      {run && run.guidanceAction?.kind === "interpretation_summary"
        && !manifest && !result && (
        <InterpretationSummaryScreen
          action={run.guidanceAction}
          busy={Boolean(busy)}
          onChangeEarlierAnswer={() => void openGuidanceHistory()}
          onResumeLater={() => void openJobs()}
          onCancel={() => void cancelRun()}
        />
      )}

      {run && run.guidanceAction?.kind === "rescue_guidance"
        && !manifest && !result && (
        <GuidedQuestionScreen
          questions={run.guidanceAction.questions}
          currentIndex={runGuidanceIndex}
          answers={runGuidanceAnswers}
          busy={Boolean(busy)}
          locked={false}
          mode="rescue"
          onAnswer={answerRunGuidance}
          onBack={() => {
            if (runGuidanceIndex > 0) {
              const questionSetHash = run.guidanceAction!.questionSetHash;
              setRunGuidanceState((current) => ({
                questionSetHash,
                answers: current.questionSetHash === questionSetHash
                  ? current.answers
                  : {},
                currentIndex: Math.max(
                  0,
                  current.questionSetHash === questionSetHash
                    ? current.currentIndex - 1
                    : 0,
                ),
              }));
              return;
            }
            void continueRunGuidance(run.guidanceAction!.questions.map((question) => ({
              questionId: question.id,
              skipped: true,
            })));
          }}
          onNext={() => void continueRunGuidance()}
          onChangeEarlierAnswer={() => void openGuidanceHistory()}
        />
      )}

      {run && !run.guidanceAction && partialDecision && !manifest && !result && (
        <PartialDecisionScreen
          decision={partialDecision}
          boundary={run.decisionAction}
          busy={busy}
          onContinueResearch={() => void continuePartialResearch()}
          onPublishPartial={() => void publishPartialPlaylist()}
          onChangeRequest={retryWithUpdatedInterpretation}
          onChangeEarlierAnswer={() => void openGuidanceHistory()}
          onCancel={() => void cancelRun()}
        />
      )}

      {run && !run.guidanceAction && !partialDecision && !run.autoPublish && reviewStatuses.has(run.status) && !manifest && (
        <ReviewScreen
          selection={trackSelection}
          busy={busy}
          onRetry={() => void retryMatching()}
          onGenerate={(selection) => void generatePlaylist(selection)}
        />
      )}

      {run && !run.guidanceAction && !partialDecision && (run.autoPublish || !reviewStatuses.has(run.status)) && !manifest && !result && (
        <RunScreen
          run={run}
          busy={busy}
          onNew={newJob}
          onRefine={retryWithUpdatedInterpretation}
          onResumeDependency={() => void resumeDependencyResearch()}
          onChangeEarlierAnswer={() => void openGuidanceHistory()}
          onCancel={() => void cancelRun()}
        />
      )}

      {manifest && !result && (
        <ManifestScreen
          manifest={manifest}
          runStatus={run?.status ?? "manifest_ready"}
          busy={["generate", "publish"].includes(busy) || ["publishing", "waiting_for_apple_authorization"].includes(run?.status ?? "")}
          onPublish={publish}
        />
      )}

      {result && (
        <ResultScreen
          result={result}
          exploreBusy={busy === "explore-visibility"}
          onExploreVisibility={(listed) => void updateExploreVisibility(listed)}
          onReset={newJob}
          onRetryUpdatedInterpretation={retryWithUpdatedInterpretation}
          onDelete={deleteRun}
        />
      )}
    </main>
  );
}
