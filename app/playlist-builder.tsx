"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type ResearchCostFactor = {
  label: string;
  minimumUsd: number;
  maximumUsd: number;
};

type ResearchCostEstimate = {
  minimumUsd: number;
  maximumUsd: number;
  approvalUsd: number;
  factors: ResearchCostFactor[];
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

type ExceptionItem = {
  candidateId: string;
  artist: string;
  title: string;
  album?: string | null;
  basis?: string;
  evidenceState?: string;
  status: string;
  song?: CatalogSong | null;
  alternatives: CatalogSong[];
};

type ExceptionPage = {
  items: ExceptionItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  unresolvedCount: number;
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
  outcomeCounts?: Record<string, number>;
  sourceCount?: number;
  unresolvedGapCount?: number;
  evidenceUrl?: string | null;
  coverageSummary?: string;
};

type BriefResponse = {
  brief?: PlaylistBrief;
  estimateUsd?: number;
  estimatedCostUsd?: number;
  estimate?: ResearchCostEstimate;
  cached?: boolean;
  requestId?: string;
  status?: string;
  pollAfterMs?: number;
  error?: string;
};

type RunResponse = {
  run?: ResearchRun;
  capability?: string;
  capabilityToken?: string;
};

type JsonObject = Record<string, unknown>;

const examples = [
  "Paulinho da Costa’s 100 most influential songs",
  "Every Michael Jackson song",
  "50 influential Berlin techno tracks",
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

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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

  if (!response.ok) throw new ApiError(extractError(payload, response.status), response.status);
  return payload as T;
}

async function waitForBrief(requestId: string, initialDelayMs = 1_500): Promise<BriefResponse> {
  let delayMs = Math.max(500, Math.min(initialDelayMs, 5_000));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await api<BriefResponse>("/api/v1/brief/" + encodeURIComponent(requestId));
    if (response.status === "failed") throw new Error(response.error || "Scope interpretation failed.");
    if (response.brief) return response;
    if (attempt >= 15) delayMs = 5_000;
  }
  throw new Error("Scope interpretation is taking longer than expected. Reload this private request URL to continue.");
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
          name: typeof volume.name === "string" ? volume.name : "Needle volume " + (index + 1),
          url: appleMusicUrl(volume.shareUrl),
          trackCount: Math.max(0, end - start + 1) || numberValue(volume.appendedCount),
          status: typeof volume.status === "string" ? volume.status : undefined,
        };
      }),
      outcomeCounts: asObject(object.outcomes) as Record<string, number>,
      sourceCount: numberValue(run.sourceCount),
      unresolvedGapCount: numberValue(run.unresolvedCount),
      evidenceUrl: runId ? "/api/v1/runs/" + encodeURIComponent(runId) + "/evidence" : null,
      coverageSummary: "Published from " + numberValue(run.sourceCount) + " documented sources with " + numberValue(run.unresolvedCount) + " visible gaps.",
    };
  }
  if (Array.isArray(object.volumes)) {
    const manifest = asObject(object.manifest);
    const rawVolumes = object.volumes;
    const manifestName = typeof manifest.name === "string" ? manifest.name : currentRun?.brief.title ?? "Needle playlist";
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
    name: typeof manifest.name === "string" ? manifest.name : "Needle playlist",
    contentHash: typeof manifest.contentHash === "string" ? manifest.contentHash : undefined,
    trackCount: numberValue(manifest.trackCount),
    tracks: [],
  };
}

function normalizeExceptionPage(payload: unknown, requestedPage: number): ExceptionPage {
  const object = asObject(payload);
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(object.items)
      ? object.items
      : Array.isArray(object.exceptions)
        ? object.exceptions
        : Array.isArray(object.matches)
          ? object.matches
          : [];
  const items = rawItems as ExceptionItem[];
  const pageSize = numberValue(object.pageSize, 20);
  const total = numberValue(object.total, items.length);
  const page = numberValue(object.page, requestedPage);
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: numberValue(object.totalPages, Math.max(1, Math.ceil(total / pageSize))),
    unresolvedCount: numberValue(
      object.unresolvedCount ?? object.unresolved,
      items.filter((item) => ["review", "unresolved", "inferred"].includes(item.status)).length,
    ),
  };
}

function exceptionChoices(item: ExceptionItem, limit = 4): CatalogSong[] {
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

function money(value: number): string {
  return "$" + numberValue(value).toFixed(2);
}

function normalizeCostEstimate(response: BriefResponse): ResearchCostEstimate {
  const legacy = numberValue(response.estimateUsd ?? response.estimatedCostUsd);
  const minimumUsd = numberValue(response.estimate?.minimumUsd, legacy);
  const maximumUsd = numberValue(response.estimate?.maximumUsd, legacy);
  return {
    minimumUsd: Math.min(minimumUsd, maximumUsd),
    maximumUsd: Math.max(minimumUsd, maximumUsd),
    approvalUsd: numberValue(response.estimate?.approvalUsd, maximumUsd),
    factors: Array.isArray(response.estimate?.factors) ? response.estimate.factors : [],
  };
}

function moneyRange(estimate: ResearchCostEstimate): string {
  if (estimate.minimumUsd === estimate.maximumUsd) return money(estimate.maximumUsd);
  return money(estimate.minimumUsd) + "–" + money(estimate.maximumUsd);
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
  if (run.status === "queued") return run.brief.mode === "curated"
    ? "Waiting to start. The two-minute target includes queue time."
    : "Waiting for an available research slot.";
  if (run.status === "publishing") return "Publishing the approved tracks to Apple Music.";
  if (run.brief.mode === "curated" && run.phase === "fast_research") return "Finding and verifying cited tracks.";
  if (run.brief.mode === "curated" && (run.status === "matching" || run.phase === "catalog_matching")) return "Matching verified tracks to Apple Music.";
  return "Searching sources and verifying recordings.";
}

function useRunPolling(
  runId: string | null,
  runStatus: string | null,
  onRun: (run: ResearchRun) => void,
  onError: (message: string) => void,
) {
  const onRunRef = useRef(onRun);
  const onErrorRef = useRef(onError);

  useEffect(() => { onRunRef.current = onRun; }, [onRun]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!runId) return;
    if (runStatus && (terminalStatuses.has(runStatus) || reviewStatuses.has(runStatus) || runStatus === "manifest_ready")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;

    const poll = async () => {
      try {
        const next = unwrapRun(await api<ResearchRun | RunResponse>("/api/v1/runs/" + encodeURIComponent(runId)));
        if (cancelled) return;
        onRunRef.current(next);
        if (terminalStatuses.has(next.status) || reviewStatuses.has(next.status) || next.status === "manifest_ready") return;
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
  }, [runId, runStatus]);
}

function AppHeader({
  step,
  transferState,
  onTransfer,
  onHome,
  onNew,
  onJobs,
}: {
  step?: number;
  transferState?: string;
  onTransfer?: () => void;
  onHome: () => void;
  onNew?: () => void;
  onJobs?: () => void;
}) {
  return (
    <header className="site-header">
      <button className="wordmark" onClick={onHome} aria-label="Needle home">
        <span aria-hidden="true">[N]</span> NEEDLE_
      </button>
      <div className="header-meta">
        {onNew && <button className="header-action" onClick={onNew}>NEW JOB</button>}
        {onJobs && <button className="header-action" onClick={onJobs}>JOBS</button>}
        {onTransfer && (
          <button className="transfer-button" onClick={onTransfer} disabled={transferState === "busy"}>
            {transferState === "copied" ? "LINK COPIED" : transferState === "busy" ? "CREATING..." : "SHARE JOB"}
          </button>
        )}
        {step != null && <span aria-label={"Step " + step + " of 6"}>{String(step).padStart(2, "0")}/06</span>}
      </div>
    </header>
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

function IntroScreen({
  stage,
  onContinue,
  onJobs,
}: {
  stage: "reveal" | "landing";
  onContinue: () => void;
  onJobs: () => void;
}) {
  if (stage === "reveal") {
    return (
      <section className="intro-screen intro-reveal" aria-label="Needle loading">
        <pre className="ascii-needle" aria-hidden="true">{String.raw`
┌────────────────────┐
│ [N] NEEDLE_        │
│     SOURCE → SONG  │
└────────────────────┘`}</pre>
        <span className="sr-only" role="status">Opening Needle</span>
      </section>
    );
  }

  return (
    <section className="intro-screen intro-landing" aria-labelledby="intro-title">
      <div className="intro-mark">
        <span aria-hidden="true">[N] NEEDLE_</span>
        <div className="intro-links">
          <button onClick={onJobs}>JOBS</button>
          <a href="/privacy">PRIVACY</a>
        </div>
      </div>
      <div className="intro-copy">
        <div className="screen-index">/ PLAYLIST RESEARCH</div>
        <h1 id="intro-title">RESEARCH A<br />PLAYLIST.</h1>
        <p>Enter a request. Needle finds cited tracks, matches them to Apple Music, and publishes a shareable playlist.</p>
      </div>
      <div className="step-footer intro-footer">
        <button className="action-button step-primary" onClick={onContinue}>
          NEW PLAYLIST →
        </button>
      </div>
    </section>
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
        <button className="flow-back" type="button" onClick={onBack}>← HOME</button>
        <div className="screen-index">/ JOBS</div>
        <h1 id="jobs-title">JOBS</h1>
        <p>Open any job available to this browser.</p>

        {loading && <div className="loading-line" role="status"><span className="cursor">▋</span>LOADING JOBS</div>}
        {!loading && jobs.length === 0 && <div className="jobs-empty">NO JOBS FOUND</div>}
        {!loading && jobs.length > 0 && (
          <div className="jobs-list">
            {jobs.map((job) => (
              <button key={job.id} onClick={() => onOpen(job.id)}>
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

function PromptScreen({
  prompt,
  busy,
  onPrompt,
  onBack,
  onSubmit,
}: {
  prompt: string;
  busy: boolean;
  onPrompt: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <section className="screen flow-screen prompt-screen" aria-labelledby="prompt-title">
      <div className="flow-body">
        <button className="flow-back" type="button" onClick={onBack}>← BACK</button>
        <div className="screen-index">/ 01 REQUEST</div>
        <h1 id="prompt-title">ENTER A<br />REQUEST.</h1>
        <p>Describe the tracks you want included.</p>

        <form className="command-form prompt-form" onSubmit={submit}>
        <label htmlFor="playlist-request">&gt; REQUEST</label>
        <div className="command-line">
          <span aria-hidden="true">$</span>
          <textarea
            id="playlist-request"
            value={prompt}
            onChange={(event) => onPrompt(event.target.value)}
            rows={3}
            maxLength={2000}
            autoFocus
            spellCheck
            placeholder="e.g. every released song..."
          />
        </div>
        </form>

        <div className="examples" aria-label="Example requests">
        <span>TRY ONE</span>
        {examples.map((example) => (
          <button
            key={example}
            className={prompt === example ? "selected" : ""}
            aria-pressed={prompt === example}
            onClick={() => onPrompt(example)}
          >
            {example}
          </button>
        ))}
        </div>
      </div>

      <div className="step-footer">
        <button
          className="action-button step-primary"
          type="button"
          onClick={onSubmit}
          disabled={busy || prompt.trim().length < 4}
        >
          {busy ? "CHECKING REQUEST..." : "REVIEW REQUEST →"}
        </button>
      </div>
    </section>
  );
}

function BriefScreen({
  brief,
  estimate,
  cached,
  busy,
  ambiguitiesAccepted,
  onBack,
  onAmbiguitiesAccepted,
  onStart,
}: {
  brief: PlaylistBrief;
  estimate: ResearchCostEstimate;
  cached: boolean;
  busy: boolean;
  ambiguitiesAccepted: boolean;
  onBack: () => void;
  onAmbiguitiesAccepted: (accepted: boolean) => void;
  onStart: () => void;
}) {
  const needsAmbiguityAcceptance = brief.ambiguities.length > 0;
  const isFast = brief.mode === "curated";
  return (
    <section className="screen flow-screen scope-screen" aria-labelledby="brief-title">
      <div className="flow-body">
        <button className="flow-back" type="button" onClick={onBack}>← EDIT REQUEST</button>
        <div className="screen-index">/ 02 REVIEW</div>
        <span className="tag profile-tag">[{isFast ? "CURATED · UNDER 2 MIN TARGET" : "EXHAUSTIVE · LONGER RUN"}]</span>
        <h1 id="brief-title">{brief.title}</h1>
        <p>{brief.description}</p>
        <p className="profile-note">{isFast
          ? "Returns a cited selection within a two-minute target. Partial results remain available if time expires."
          : "Searches the configured sources for all documented matches and reports unresolved gaps."}</p>

        <div className="scope-snapshot" aria-label="Research scope summary">
          <div><span>TARGET</span><strong>{brief.targetSize ? brief.targetSize.min + "–" + brief.targetSize.max + " tracks" : "All documented tracks"}</strong></div>
          <div><span>EVIDENCE</span><strong>{brief.evidencePolicy}</strong></div>
        </div>

        <details className="terminal-details scope-details">
          <summary>FULL SCOPE</summary>
          <dl>
            <div><dt>SUBJECT</dt><dd>{brief.subjectEntities.join(", ") || "—"}</dd></div>
            <div><dt>RELATIONSHIP</dt><dd>{brief.relationship}</dd></div>
            <div><dt>VERSIONS</dt><dd>{brief.versionPolicy}</dd></div>
            <div><dt>ORDER</dt><dd>{brief.orderingPolicy || "Evidence confidence, then release date"}</dd></div>
            <div><dt>INCLUDE</dt><dd>{brief.include.join(" / ") || "All qualifying recordings"}</dd></div>
            <div><dt>EXCLUDE</dt><dd>{brief.exclude.join(" / ") || "Nothing beyond the stated scope"}</dd></div>
          </dl>
        </details>

        {needsAmbiguityAcceptance && (
          <div className="assumption-block">
            <strong>CONFIRM {brief.ambiguities.length} ASSUMPTION{brief.ambiguities.length === 1 ? "" : "S"}</strong>
            <ul>{brief.ambiguities.map((item) => <li key={item}>{item}</li>)}</ul>
            <label className="ambiguity-confirmation">
              <input
                type="checkbox"
                checked={ambiguitiesAccepted}
                onChange={(event) => onAmbiguitiesAccepted(event.target.checked)}
              />
              <span>I ACCEPT THESE ASSUMPTIONS.</span>
            </label>
          </div>
        )}

        {!cached && estimate.factors.length > 0 && (
          <details className="terminal-details cost-details">
            <summary>COST BASIS [{estimate.factors.length}]</summary>
            <ul>{estimate.factors.map((factor) => <li key={factor.label}>{factor.label}</li>)}</ul>
          </details>
        )}
      </div>

      <div className="step-footer scope-footer">
        <div className="estimate">
          <span>{cached ? "CACHED" : "ESTIMATE"}</span>
          <strong>{cached ? "$0.00" : moneyRange(estimate)}</strong>
        </div>
        <button
          className="action-button step-primary"
          onClick={onStart}
          disabled={busy || (needsAmbiguityAcceptance && !ambiguitiesAccepted)}
        >
          {busy ? "STARTING..." : "START RESEARCH →"}
        </button>
      </div>
    </section>
  );
}

function RunScreen({ run, onNew }: { run: ResearchRun; onNew: () => void }) {
  const progress = progressByPhase[run.phase] ?? (run.status === "queued" ? 4 : 12);
  const showReset = terminalStatuses.has(run.status);
  const profile = run.brief.mode === "curated" ? "CURATED" : "EXHAUSTIVE";

  return (
    <section className="screen flow-screen research-screen" aria-labelledby="run-title">
      <div className="flow-body research-body">
        <div className="screen-index">/ 03 RESEARCH</div>
        <span className="tag profile-tag">[{profile} · {statusLabel(run.status).toUpperCase()}]</span>
        <h1 id="run-title">RESEARCH IN<br />PROGRESS.</h1>
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

function ReviewScreen({
  page,
  busy,
  onDecision,
  onManifest,
}: {
  page: ExceptionPage | null;
  busy: string;
  onDecision: (item: ExceptionItem, decision: "accepted" | "rejected", song?: CatalogSong) => Promise<void>;
  onManifest: (verifiedOnly: boolean) => void;
}) {
  const unresolved = page?.unresolvedCount ?? 0;
  const active = page?.items[0] ?? null;
  const [reviewedCount, setReviewedCount] = useState(0);

  async function decide(decision: "accepted" | "rejected", song?: CatalogSong) {
    if (!active) return;
    try {
      await onDecision(active, decision, song);
      setReviewedCount((count) => count + 1);
    } catch {
      // The parent surface displays the actionable request error.
    }
  }

  const total = page ? Math.max(page.total, page.items.length) : 0;
  const position = total > 0 ? Math.min(reviewedCount + 1, total) : 0;

  return (
    <section className="screen flow-screen review-screen" aria-labelledby="review-title">
      <div className="flow-body review-body">
        <div className="screen-index">/ 04 REVIEW MATCHES</div>
        {!page && <div className="loading-line" role="status"><span className="cursor">▋</span>LOADING EXCEPTIONS</div>}
        {page && !active && (
          <div className="review-complete">
            <span className="tag">[NO REVIEW REQUIRED]</span>
            <h1 id="review-title">TRACKS<br />READY.</h1>
            <p>Every candidate has a recorded outcome.</p>
          </div>
        )}
        {active && (
          <>
            <span className="tag">[{position} OF {total}]</span>
            <h1 id="review-title">{active.title}</h1>
            <p className="exception-artist">{active.artist}{active.album ? " / " + active.album : ""}</p>
            <p className="exception-basis">{active.basis || active.evidenceState || statusLabel(active.status)}</p>
            <div className="exception-actions exception-choices" aria-label="Apple Music match choices">
              {exceptionChoices(active).map((song) => (
                <button
                  key={song.id}
                  onClick={() => void decide("accepted", song)}
                  disabled={Boolean(busy)}
                >
                  <span>USE THIS MATCH</span>
                  <strong>{song.name}</strong>
                  <small>{song.artistName}{song.albumName ? " / " + song.albumName : ""}</small>
                </button>
              ))}
              <button
                className="reject"
                onClick={() => void decide("rejected")}
                disabled={Boolean(busy)}
              >
                EXCLUDE THIS TRACK
              </button>
            </div>
          </>
        )}
      </div>

      <div className="step-footer review-footer">
        {unresolved > 0 ? (
          <button className="quiet-button" onClick={() => onManifest(true)} disabled={!page || Boolean(busy)}>
            USE VERIFIED TRACKS · SKIP {unresolved}
          </button>
        ) : (
          <button className="action-button step-primary" onClick={() => onManifest(false)} disabled={!page || Boolean(busy)}>
            {busy === "manifest" ? "PREPARING..." : "PREPARE PLAYLIST →"}
          </button>
        )}
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
        <div className="screen-index">/ 05 PUBLISH</div>
        <span className="tag">[{volumeCount} {volumeCount === 1 ? "VOLUME" : "VOLUMES"}]</span>
        <h1 id="manifest-title">{trackCount.toLocaleString()} TRACKS<br />READY.</h1>
        <p>{waitingForApple
          ? "Publication will resume after the owner reconnects Apple Music."
          : publishing
            ? "Publishing the playlist to Apple Music."
            : "Review is complete. Publishing will use this exact track order."}</p>

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
              ? "PUBLICATION IN PROGRESS..."
              : "PUBLISH PLAYLIST →"}
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

  return (
    <section className="screen flow-screen result-screen" aria-labelledby="result-title">
      <div className="flow-body">
        <div className="screen-index">/ 06 RESULT</div>
        <span className="tag">[{result.volumes.length} {result.volumes.length === 1 ? "VOLUME" : "VOLUMES"}]</span>
        <h1 id="result-title">{result.status === "partial" ? "PLAYLIST PUBLISHED<br />WITH GAPS." : "PLAYLIST<br />PUBLISHED."}</h1>
        <p>{result.coverageSummary || "The Apple Music links and coverage report are ready."}</p>
        <small className="result-note">Share-link access is public; Apple search, profile visibility, and regional availability are not guaranteed.</small>

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
  const [entryStage, setEntryStage] = useState<"reveal" | "landing" | "prompt" | "jobs">("reveal");
  const [prompt, setPrompt] = useState("");
  const [brief, setBrief] = useState<PlaylistBrief | null>(null);
  const [briefRequestId, setBriefRequestId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<ResearchCostEstimate>({
    minimumUsd: 0,
    maximumUsd: 0,
    approvalUsd: 0,
    factors: [],
  });
  const [ambiguitiesAccepted, setAmbiguitiesAccepted] = useState(false);
  const [cached, setCached] = useState(false);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [exceptionPage, setExceptionPage] = useState<ExceptionPage | null>(null);
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
  const publishingRef = useRef(false);
  const reviewingRef = useRef(false);

  const clearCurrent = useCallback((nextStage: "landing" | "prompt" | "jobs") => {
    setEntryStage(nextStage);
    setPrompt("");
    setBrief(null);
    setBriefRequestId(null);
    setEstimate({ minimumUsd: 0, maximumUsd: 0, approvalUsd: 0, factors: [] });
    setAmbiguitiesAccepted(false);
    setCached(false);
    setRun(null);
    activeRunId.current = null;
    setExceptionPage(null);
    setManifest(null);
    setResult(null);
    setBusy("");
    setError("");
    setTransferState("");
    idempotencyKey.current = null;
    briefIdempotencyKey.current = null;
    publishingRef.current = false;
    reviewingRef.current = false;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const reset = useCallback(() => clearCurrent("landing"), [clearCurrent]);
  const newJob = useCallback(() => clearCurrent("prompt"), [clearCurrent]);

  const updateRun = useCallback((next: ResearchRun) => {
    if (activeRunId.current !== next.id) return;
    setRun(next);
    if (next.status === "failed" && next.error) setError(next.error);
  }, []);

  useRunPolling(run?.id ?? null, run?.status ?? null, updateRun, setError);

  const loadRun = useCallback(async (runId: string) => {
    activeRunId.current = runId;
    const next = unwrapRun(await api<ResearchRun | RunResponse>("/api/v1/runs/" + encodeURIComponent(runId)));
    if (activeRunId.current !== runId) return;
    activeRunId.current = next.id;
    setRun(next);
    setBrief(next.brief);
    setPrompt(next.prompt);
  }, []);

  const openJobs = useCallback(async () => {
    clearCurrent("jobs");
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
    clearCurrent("landing");
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

  const exchangeCapability = useCallback(async (token: string, hintedRunId?: string | null) => {
    const payload = await api<JsonObject>("/api/v1/capabilities/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    const runId = typeof payload.runId === "string"
      ? payload.runId
      : typeof payload.id === "string"
        ? payload.id
        : hintedRunId;
    if (runId) {
      const query = new URLSearchParams();
      query.set("run", runId);
      window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
      await loadRun(runId);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [loadRun]);

  useEffect(() => {
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
        else if (queuedBriefId) {
          const response = await waitForBrief(queuedBriefId);
          setBrief(response.brief ?? null);
          setBriefRequestId(queuedBriefId);
          setEstimate(normalizeCostEstimate(response));
          setAmbiguitiesAccepted(false);
        }
      } catch (caught) {
        setError((caught as Error).message);
        const status = caught instanceof ApiError ? caught.status : 0;
        if ([400, 401, 404, 410].includes(status)) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      } finally {
        setRestoring(false);
      }
    };
    void restore();
  }, [exchangeCapability, loadRun]);

  useEffect(() => {
    if (restoring || entryStage !== "reveal" || brief || run || manifest || result) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1_350;
    const timer = window.setTimeout(() => setEntryStage("landing"), delay);
    return () => window.clearTimeout(timer);
  }, [restoring, entryStage, brief, run, manifest, result]);

  const loadExceptions = useCallback(async (pageNumber: number) => {
    if (!run) return;
    setBusy("exceptions");
    try {
      const payload = await api<unknown>(
        "/api/v1/runs/" + encodeURIComponent(run.id) + "/exceptions?page=" + pageNumber + "&pageSize=20",
      );
      setExceptionPage(normalizeExceptionPage(payload, pageNumber));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }, [run]);

  useEffect(() => {
    if (!run || !reviewStatuses.has(run.status)) return;
    const timer = window.setTimeout(() => void loadExceptions(1), 0);
    return () => window.clearTimeout(timer);
  }, [run, loadExceptions]);

  useEffect(() => {
    if (!run || run.status !== "manifest_ready" || manifest) return;
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

  async function interpret() {
    if (prompt.trim().length < 4) return;
    setBusy("brief");
    setError("");
    if (!briefIdempotencyKey.current) briefIdempotencyKey.current = crypto.randomUUID();
    try {
      let response = await api<BriefResponse>("/api/v1/brief", {
        method: "POST",
        headers: { "Idempotency-Key": briefIdempotencyKey.current },
        body: JSON.stringify({
          prompt: prompt.trim(),
          idempotencyKey: briefIdempotencyKey.current,
        }),
      });
      if (!response.brief && response.requestId) {
        const requestId = response.requestId;
        const query = new URLSearchParams();
        query.set("brief", requestId);
        window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
        response = await waitForBrief(requestId, numberValue(response.pollAfterMs, 1_500));
      }
      if (!response.brief) throw new Error("Scope interpretation is taking longer than expected. Retry with the same request.");
      setBrief(response.brief);
      setBriefRequestId(response.requestId ?? null);
      setEstimate(normalizeCostEstimate(response));
      setAmbiguitiesAccepted(false);
      setCached(Boolean(response.cached));
      briefIdempotencyKey.current = null;
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function startResearch() {
    if (!brief) return;
    if (brief.ambiguities.length > 0 && !ambiguitiesAccepted) {
      setError("Accept every material scope assumption before research.");
      return;
    }
    setBusy("run");
    setError("");
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    try {
      const confirmedBrief: PlaylistBrief = brief.ambiguities.length > 0
        ? { ...brief, ambiguityAcceptance: [...brief.ambiguities] }
        : brief;
      const response = await api<ResearchRun | RunResponse>("/api/v1/runs", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({
          briefRequestId,
          brief: confirmedBrief,
        }),
      });
      const next = unwrapRun(response);
      const object = asObject(response);
      const capability = typeof object.capability === "string"
        ? object.capability
        : typeof object.capabilityToken === "string"
          ? object.capabilityToken
          : "";
      if (!capability) throw new Error("Needle could not establish a private session for this run.");
      const fragment = "cap=" + encodeURIComponent(capability) + "&run=" + encodeURIComponent(next.id);
      window.history.replaceState(null, "", window.location.pathname + window.location.search + "#" + fragment);
      await exchangeCapability(capability, next.id);
      idempotencyKey.current = null;
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function review(item: ExceptionItem, decision: "accepted" | "rejected", song?: CatalogSong) {
    if (!run || reviewingRef.current) return;
    reviewingRef.current = true;
    setBusy(item.candidateId);
    setError("");
    try {
      await api("/api/v1/runs/" + encodeURIComponent(run.id) + "/review", {
        method: "POST",
        body: JSON.stringify({
          candidateId: item.candidateId,
          decision,
          catalogId: song?.id,
          song,
        }),
      });
      await loadExceptions(exceptionPage?.page ?? 1);
    } catch (caught) {
      setError((caught as Error).message);
      throw caught;
    } finally {
      reviewingRef.current = false;
      setBusy("");
    }
  }

  async function buildManifest(verifiedOnly: boolean) {
    if (!run) return;
    setBusy("manifest");
    setError("");
    try {
      const response = await api<PlaylistManifest | { manifest: PlaylistManifest }>(
        "/api/v1/runs/" + encodeURIComponent(run.id) + "/manifest",
        {
          method: "POST",
          body: JSON.stringify({ mode: verifiedOnly ? "verified_only" : "reviewed" }),
        },
      );
      setManifest(unwrapManifest(response));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function publish() {
    if (!run || !manifest || publishingRef.current) return;
    publishingRef.current = true;
    setBusy("publish");
    setError("");
    try {
      const response = await api<ResearchRun | RunResponse>(
        "/api/v1/runs/" + encodeURIComponent(run.id) + "/publish",
        {
          method: "POST",
          headers: { "Idempotency-Key": "publish-" + manifest.id },
          body: JSON.stringify({ manifestId: manifest.id }),
        },
      );
      setRun(unwrapRun(response));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      publishingRef.current = false;
      setBusy("");
    }
  }

  async function deleteRun() {
    if (!run || !window.confirm("Delete this run’s research data from Needle? Published Apple playlists will remain.")) return;
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
      if (!capability) throw new Error("Needle did not return a transfer capability.");
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

  const step = useMemo(() => {
    if (result) return 6;
    if (manifest) return 5;
    if (run && reviewStatuses.has(run.status)) return 4;
    if (run) return 3;
    if (brief) return 2;
    return 1;
  }, [brief, run, manifest, result]);

  if (restoring) {
    return (
      <main className="app-shell">
        <AppHeader
          step={1}
          onHome={reset}
        />
        <section className="screen restore-screen" role="status">
          <span className="cursor" aria-hidden="true">▋</span>RESTORING RUN
        </section>
      </main>
    );
  }

  if (!brief && !run && !manifest && !result && (entryStage === "reveal" || entryStage === "landing")) {
    return (
      <main className="app-shell entry-shell">
        <ErrorBar message={error} onDismiss={() => setError("")} />
        <IntroScreen
          stage={entryStage}
          onContinue={newJob}
          onJobs={() => void openJobs()}
        />
      </main>
    );
  }

  if (!brief && !run && !manifest && !result && entryStage === "jobs") {
    return (
      <main className="app-shell">
        <AppHeader
          onHome={reset}
          onNew={newJob}
          onJobs={() => void openJobs()}
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
      {(brief || run || manifest || result) && (
        <AppHeader
          step={step}
          transferState={transferState}
          onTransfer={run ? transferRun : undefined}
          onHome={reset}
          onNew={newJob}
          onJobs={() => void openJobs()}
        />
      )}
      <ErrorBar message={error} onDismiss={() => setError("")} />

      {!brief && entryStage === "prompt" && (
        <PromptScreen
          prompt={prompt}
          busy={busy === "brief"}
          onPrompt={(value) => {
            setPrompt(value);
            briefIdempotencyKey.current = null;
          }}
          onBack={reset}
          onSubmit={interpret}
        />
      )}

      {brief && !run && (
        <BriefScreen
          brief={brief}
          estimate={estimate}
          cached={cached}
          busy={busy === "run"}
          ambiguitiesAccepted={ambiguitiesAccepted}
          onBack={() => {
            setBrief(null);
            setBriefRequestId(null);
            setAmbiguitiesAccepted(false);
            setEntryStage("prompt");
            idempotencyKey.current = null;
            window.history.replaceState(null, "", window.location.pathname);
          }}
          onAmbiguitiesAccepted={setAmbiguitiesAccepted}
          onStart={startResearch}
        />
      )}

      {run && reviewStatuses.has(run.status) && !manifest && (
        <ReviewScreen
          page={exceptionPage}
          busy={busy}
          onDecision={review}
          onManifest={buildManifest}
        />
      )}

      {run && !reviewStatuses.has(run.status) && !manifest && !result && (
        <RunScreen run={run} onNew={newJob} />
      )}

      {manifest && !result && (
        <ManifestScreen
          manifest={manifest}
          runStatus={run?.status ?? "manifest_ready"}
          busy={busy === "publish" || ["publishing", "waiting_for_apple_authorization"].includes(run?.status ?? "")}
          onPublish={publish}
        />
      )}

      {result && <ResultScreen result={result} onReset={newJob} onDelete={deleteRun} />}
    </main>
  );
}
