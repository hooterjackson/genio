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
import { BrandIntro } from "./brand-intro";
import { type PrimaryNavItem } from "./primary-nav";
import { PublicSiteHeader } from "./public-site-header";
import {
  apiErrorCode,
  evidenceCountSummary,
  publishedTrackCountSummary,
  publishedResultHeading,
  shouldQuietlyClearInitialRunRestore,
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
  estimatedCostUsd: number;
  actualCostUsd: number;
  approvedBudgetUsd?: number;
  phase: string;
  autoPublish?: boolean;
  error?: string | null;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  frontier: FrontierItem[];
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
};

type BriefResponse = {
  brief?: PlaylistBrief;
  prompt?: string;
  requestedTrackCount?: number | null;
  estimateUsd?: number;
  estimatedCostUsd?: number;
  cached?: boolean;
  requestId?: string;
  status?: string;
  pollAfterMs?: number;
  questions?: GuidedQuestion[];
  error?: string;
};

type GuidedQuestionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
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
  customText?: string;
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

const terminalStatuses = new Set(["complete", "partial", "failed", "expired", "deleted"]);
const reviewStatuses = new Set(["review", "visitor_review"]);
const progressByPhase: Record<string, number> = {
  queued: 4,
  scope: 9,
  source_discovery: 18,
  fast_research: 55,
  container_discovery: 30,
  container_enumeration: 44,
  track_verification: 62,
  catalog_enrichment: 75,
  gap_analysis: 88,
  matching: 88,
  catalog_matching: 88,
  research_complete: 82,
};

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
  if (run.status === "awaiting_budget") return "Paused for owner budget approval.";
  if (run.status === "waiting_for_apple_authorization") return "Paused until the owner reconnects Apple Music.";
  if (run.status === "failed") return run.error || "Research failed.";
  const requestedTracks = run.brief.targetSize?.min ?? PUBLIC_PLAYLIST_DEFAULT_TRACKS;
  const windowPhrase = fastRunWindowPhrase(requestedTracks);
  if (run.status === "queued") return run.brief.mode === "curated"
    ? `Queued. The ${windowPhrase} research window includes queue time.`
    : "Waiting for an available research slot.";
  if (run.status === "publishing") return "Publishing matched tracks to Apple Music.";
  if (run.brief.mode === "curated" && run.phase === "fast_research") {
    return `Finding and verifying cited tracks within the ${windowPhrase} window.`;
  }
  if (run.brief.mode === "curated" && (run.status === "matching" || run.phase === "catalog_matching")) {
    return `Matching verified tracks within the ${windowPhrase} window.`;
  }
  return "Searching sources and verifying recordings.";
}

function useRunPolling(
  runId: string | null,
  runStatus: string | null,
  autoPublish: boolean,
  onRun: (run: ResearchRun) => void,
  onError: (message: string) => void,
) {
  const onRunRef = useRef(onRun);
  const onErrorRef = useRef(onError);

  useEffect(() => { onRunRef.current = onRun; }, [onRun]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!runId) return;
    const automaticHandoff = autoPublish && Boolean(
      runStatus && (reviewStatuses.has(runStatus) || runStatus === "manifest_ready"),
    );
    if (runStatus && !automaticHandoff
      && (terminalStatuses.has(runStatus) || reviewStatuses.has(runStatus) || runStatus === "manifest_ready")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;

    const poll = async () => {
      try {
        const next = unwrapRun(await api<ResearchRun | RunResponse>("/api/v1/runs/" + encodeURIComponent(runId)));
        if (cancelled) return;
        onRunRef.current(next);
        const nextAutomaticHandoff = next.autoPublish === true
          && (reviewStatuses.has(next.status) || next.status === "manifest_ready");
        if (!nextAutomaticHandoff
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
  }, [runId, runStatus, autoPublish]);
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
            {jobs.map((job) => (
              <button
                key={job.id}
                onClick={() => onOpen(job.id)}
                aria-label={`Open ${job.brief.title} — ${statusLabel(job.status)}`}
              >
                <span className="job-status">{statusLabel(job.status).toUpperCase()}</span>
                <strong>{job.brief.title}</strong>
                <small>{job.candidateCount.toLocaleString()} tracks · {job.brief.mode}</small>
                <span className="job-open">OPEN →</span>
              </button>
            ))}
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
  onPrompt,
  onTrackCount,
  onSubmit,
}: {
  prompt: string;
  trackCount: string;
  busy: string;
  onPrompt: (value: string) => void;
  onTrackCount: (value: string) => void;
  onSubmit: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [exampleIndex, setExampleIndex] = useState(0);
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
    onSubmit();
  }

  function choosePreset(value: number) {
    onTrackCount(String(value));
  }

  function chooseCustom() {
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
        <form className="one-command-form" onSubmit={submit} aria-busy={Boolean(busy)}>
          <section className="command-request-section" aria-labelledby="request-step-title">
            <h2 className="sr-only" id="request-step-title">Playlist request</h2>
            <label className="one-command-request" htmlFor="playlist-request">
              <span className="sr-only">PLAYLIST REQUEST</span>
              <textarea
                id="playlist-request"
                value={prompt}
                onChange={(event) => onPrompt(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                rows={5}
                maxLength={2000}
                spellCheck
                required
                disabled={Boolean(busy)}
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
                    disabled={Boolean(busy)}
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
                  disabled={Boolean(busy)}
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
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={trackCount}
                    onChange={(event) => onTrackCount(event.target.value)}
                    required
                    disabled={Boolean(busy)}
                    aria-invalid={countInvalid || trackCount.length === 0}
                    aria-describedby="playlist-track-count-note"
                    aria-label="Exact track count"
                    placeholder="1–300"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => choosePreset(PUBLIC_PLAYLIST_DEFAULT_TRACKS)}
                  disabled={Boolean(busy)}
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
              disabled={Boolean(busy) || prompt.trim().length < 4 || !validCount}
            >
              {busy ? "STARTING..." : "CREATE PLAYLIST"}
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
}: {
  questions: GuidedQuestion[];
  currentIndex: number;
  answers: Record<string, GuidedAnswer>;
  busy: boolean;
  locked: boolean;
  onAnswer: (answer: GuidedAnswer) => void;
  onBack: () => void;
  onNext: () => void;
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
    .slice(0, 3);
  const validAnswer = Boolean(currentAnswer?.optionId || customText.trim());
  const lastQuestion = currentIndex === questions.length - 1;
  const groupName = "guidance-" + question.id;
  const progress = ((currentIndex + 1) / questions.length) * 100;

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

        <p className="guided-question-kicker">{question.header || "REFINE THE PLAYLIST"}</p>
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

        <fieldset className="guided-options" disabled={busy || locked}>
          <legend className="sr-only">{question.question}</legend>
          {orderedOptions.map((option, index) => {
            const selected = currentAnswer?.optionId === option.id;
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
                  type="radio"
                  name={groupName}
                  value={option.id}
                  checked={selected}
                  onChange={() => onAnswer({ questionId: question.id, optionId: option.id })}
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

          <div className="guided-custom-card" data-selected={customSelected || undefined}>
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
          </div>
        </fieldset>
      </div>

      <div className="guided-question-footer">
        <button className="guided-back" type="button" onClick={onBack} disabled={busy}>
          ← {locked || currentIndex === 0 ? "EDIT REQUEST" : "BACK"}
        </button>
        <button
          className="guided-next"
          type="button"
          onClick={onNext}
          disabled={busy || !validAnswer}
        >
          {busy
            ? "FINALIZING..."
            : locked
              ? "RETRY CREATE →"
              : lastQuestion
                ? "CREATE PLAYLIST →"
                : "NEXT →"}
        </button>
      </div>
    </section>
  );
}

function FinalizingBriefScreen() {
  return (
    <section className="guided-question-screen guided-finalizing-screen" role="status" aria-live="polite">
      <div className="guided-question-body">
        <span className="guided-question-kicker">PREPARING</span>
        <h1>Preparing your playlist</h1>
        <p>Applying your answers before research begins.</p>
        <div className="guided-finalizing-line"><span aria-hidden="true">▋</span>FINALIZING REQUEST</div>
      </div>
    </section>
  );
}

function RunScreen({ run, onNew }: { run: ResearchRun; onNew: () => void }) {
  const progress = progressByPhase[run.phase] ?? (run.status === "queued" ? 4 : 12);
  const showReset = terminalStatuses.has(run.status);
  const profile = run.brief.mode === "curated" ? "CURATED" : "EXHAUSTIVE";
  const publishing = ["publishing", "waiting_for_apple_authorization", "manifest_ready"].includes(run.status);

  return (
    <section className="screen flow-screen research-screen" aria-labelledby="run-title">
      <div className="flow-body research-body">
        <span className="tag profile-tag">[{profile} · {statusLabel(run.status).toUpperCase()}]</span>
        <h1 id="run-title">{publishing ? "Creating your playlist" : "Researching your playlist"}</h1>
        <p className="run-subject">{run.brief.title}</p>
        <p className="research-status" role="status">{phaseMessage(run)}</p>
        <div className="progress research-progress" aria-label={"Research " + progress + "% complete"}>
          <span style={{ width: progress + "%" }} />
        </div>
        <div className="phase-line"><span className="cursor" aria-hidden="true">▋</span>{statusLabel(run.phase || run.status)}</div>
      </div>

      {showReset && (
        <div className="step-footer">
          <button className="action-button step-primary" onClick={onNew}>NEW JOB →</button>
        </div>
      )}
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
        <div className="loading-line" role="status"><span className="cursor">▋</span>LOADING TRACKS</div>
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
  onReset,
  onDelete,
}: {
  result: RunResult;
  onReset: () => void;
  onDelete: () => void;
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
        <button className="quiet-button" onClick={onReset}>← NEW JOB</button>
        {result.evidenceUrl && <a className="quiet-link" href={result.evidenceUrl} target="_blank" rel="noreferrer">VIEW EVIDENCE ↗</a>}
        <button className="text-danger" onClick={onDelete}>DELETE RUN DATA</button>
      </div>
    </section>
  );
}

export function PlaylistBuilder() {
  const [entryStage, setEntryStage] = useState<"command" | "jobs">("command");
  const [prompt, setPrompt] = useState("");
  const [trackCount, setTrackCount] = useState(String(PUBLIC_PLAYLIST_DEFAULT_TRACKS));
  const [brief, setBrief] = useState<PlaylistBrief | null>(null);
  const [briefRequestId, setBriefRequestId] = useState<string | null>(null);
  const [guidanceQuestions, setGuidanceQuestions] = useState<GuidedQuestion[]>([]);
  const [guidanceAnswers, setGuidanceAnswers] = useState<Record<string, GuidedAnswer>>({});
  const [guidanceIndex, setGuidanceIndex] = useState(0);
  const [guidanceSubmission, setGuidanceSubmission] = useState<GuidedAnswer[] | null>(null);
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
  const publishingRef = useRef(false);
  const matchingRetryAttempted = useRef<Set<string>>(new Set());
  const briefRequestRef = useRef<AbortController | null>(null);
  const tracksRequestRef = useRef<AbortController | null>(null);
  const operationRequestRef = useRef<AbortController | null>(null);
  const restoreStartedRef = useRef(false);

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
    setGuidanceAnswers({});
    setGuidanceIndex(0);
    setGuidanceSubmission(null);
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
    publishingRef.current = false;
    matchingRetryAttempted.current.clear();
    window.history.replaceState(null, "", window.location.pathname);
  }, [briefRequestId, deleteAbandonedBrief, manifest, result, run]);

  const reset = useCallback(() => clearCurrent("command"), [clearCurrent]);
  const newJob = useCallback(() => clearCurrent("command"), [clearCurrent]);

  const updateRun = useCallback((next: ResearchRun) => {
    if (activeRunId.current !== next.id) return;
    setRun(next);
    if (next.status === "failed" && next.error) setError(next.error);
  }, []);

  useRunPolling(run?.id ?? null, run?.status ?? null, run?.autoPublish === true, updateRun, setError);

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
    signal?: AbortSignal,
  ) => {
    if (!idempotencyKey.current) idempotencyKey.current = "run-" + nextBriefRequestId;
    const response = await api<ResearchRun | RunResponse>("/api/v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey.current },
      body: JSON.stringify({
        briefRequestId: nextBriefRequestId,
        brief: nextBrief,
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
          if (!response.brief) throw new Error("The playlist request could not be restored.");
          setPrompt(response.prompt ?? "");
          const restoredCount = response.requestedTrackCount ?? exactRequestedTrackCount(response.brief);
          if (restoredCount) setTrackCount(String(restoredCount));
          setBrief(response.brief);
          setBriefRequestId(queuedBriefId);
          if (response.status === "awaiting_answers" && response.questions?.length) {
            setGuidanceQuestions(response.questions);
            setGuidanceAnswers({});
            setGuidanceIndex(0);
            setGuidanceSubmission(null);
            setBriefFinalizing(false);
          } else {
            await startResearchFromBrief(response.brief, queuedBriefId);
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
  }, [exchangeCapability, loadRun, openJobs, startResearchFromBrief]);

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
    if (!run || !["complete", "partial"].includes(run.status) || result) return;
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

  async function createPlaylist() {
    const requestedTrackCount = /^[0-9]+$/u.test(trackCount)
      ? Number.parseInt(trackCount, 10)
      : Number.NaN;
    if (prompt.trim().length < 4
      || !Number.isInteger(requestedTrackCount)
      || requestedTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
      || requestedTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS) return;
    briefRequestRef.current?.abort();
    const controller = new AbortController();
    briefRequestRef.current = controller;
    setBusy("create");
    setError("");
    try {
      if (brief && briefRequestId) {
        setBriefFinalizing(true);
        await startResearchFromBrief(brief, briefRequestId, controller.signal);
        return;
      }
      if (!briefIdempotencyKey.current) briefIdempotencyKey.current = crypto.randomUUID();
      let response = await api<BriefResponse>("/api/v1/brief", {
        method: "POST",
        headers: { "Idempotency-Key": briefIdempotencyKey.current },
        body: JSON.stringify({
          prompt: prompt.trim(),
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
      const requestId = response.requestId ?? initialRequestId;
      if (!requestId) throw new Error("gênio could not resume this playlist request.");
      setBrief(response.brief);
      setBriefRequestId(requestId);
      if (response.status === "awaiting_answers" && response.questions?.length) {
        setGuidanceQuestions(response.questions);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setBriefFinalizing(false);
      } else {
        setBriefFinalizing(true);
        await startResearchFromBrief(response.brief, requestId, controller.signal);
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
    setGuidanceAnswers({});
    setGuidanceIndex(0);
    setGuidanceSubmission(null);
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
    setGuidanceAnswers((current) => ({ ...current, [answer.questionId]: answer }));
  }

  async function continueGuidance() {
    const question = guidanceQuestions[guidanceIndex];
    if (!question || !briefRequestId) return;
    const answer = guidanceAnswers[question.id];
    if (!answer?.optionId && !answer?.customText?.trim()) return;
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
            idempotencyKey: guidanceIdempotencyKey.current,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (response.status === "failed") {
        throw new BriefInterpretationError(response.error || "The playlist request could not be finalized.");
      }

      const finalized = await waitForBrief(
        briefRequestId,
        numberValue(response.pollAfterMs, 1_500),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (finalized.status === "awaiting_answers" && finalized.questions?.length) {
        setBrief(finalized.brief ?? brief);
        setGuidanceQuestions(finalized.questions);
        setGuidanceAnswers({});
        setGuidanceIndex(0);
        setGuidanceSubmission(null);
        setBriefFinalizing(false);
        guidanceIdempotencyKey.current = null;
        return;
      }
      if (!finalized.brief) throw new Error("The playlist request could not be finalized.");
      setBrief(finalized.brief);
      await startResearchFromBrief(finalized.brief, briefRequestId, controller.signal);
    } catch (caught) {
      if (isAbortError(caught)) return;
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
          onAnswer={answerGuidance}
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
        <BrandIntro />
        <AppHeader onHome={reset} onJobs={() => void openJobs()} />
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <OneCommandScreen
          prompt={prompt}
          trackCount={trackCount}
          busy={busy}
          onPrompt={(value) => {
            setPrompt(value);
            setBrief(null);
            setBriefRequestId(null);
            briefIdempotencyKey.current = null;
            idempotencyKey.current = null;
          }}
          onTrackCount={(value) => {
            setTrackCount(value);
            setBrief(null);
            setBriefRequestId(null);
            briefIdempotencyKey.current = null;
            idempotencyKey.current = null;
          }}
          onSubmit={() => void createPlaylist()}
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
      <ErrorBar message={error} onDismiss={() => setError("")} />

      {run && !run.autoPublish && reviewStatuses.has(run.status) && !manifest && (
        <ReviewScreen
          selection={trackSelection}
          busy={busy}
          onRetry={() => void retryMatching()}
          onGenerate={(selection) => void generatePlaylist(selection)}
        />
      )}

      {run && (run.autoPublish || !reviewStatuses.has(run.status)) && !manifest && !result && (
        <RunScreen run={run} onNew={newJob} />
      )}

      {manifest && !result && (
        <ManifestScreen
          manifest={manifest}
          runStatus={run?.status ?? "manifest_ready"}
          busy={["generate", "publish"].includes(busy) || ["publishing", "waiting_for_apple_authorization"].includes(run?.status ?? "")}
          onPublish={publish}
        />
      )}

      {result && <ResultScreen result={result} onReset={newJob} onDelete={deleteRun} />}
    </main>
  );
}
