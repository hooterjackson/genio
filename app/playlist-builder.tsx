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
  "Every released song Paulinho da Costa performed on",
  "Every Michael Jackson song",
  "Influential Berlin techno",
];

const terminalStatuses = new Set(["complete", "partial", "failed", "expired", "deleted"]);
const reviewStatuses = new Set(["review", "visitor_review"]);
const progressByPhase: Record<string, number> = {
  queued: 4,
  scope: 9,
  source_discovery: 18,
  container_discovery: 30,
  container_enumeration: 44,
  track_verification: 62,
  catalog_enrichment: 75,
  gap_analysis: 88,
  matching: 94,
  research_complete: 100,
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
  if (run.status === "awaiting_budget") return "Research is paused while the owner reviews the next spending window.";
  if (run.status === "waiting_for_apple_authorization") return "The manifest is safe; publication resumes after the owner reconnects Apple Music.";
  if (run.status === "failed") return run.error || "The run stopped before completion.";
  if (run.status === "queued") return "Your request is queued and will begin when a research slot opens.";
  if (run.status === "publishing") return "Needle is publishing the locked manifest in ordered, reconciled Apple Music batches.";
  return "Needle is tracing sources, verifying recordings, and preserving every unresolved gap.";
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
        timer = setTimeout(poll, pollCount < 12 ? 5000 : 15000);
      } catch (caught) {
        if (cancelled) return;
        const error = caught as ApiError;
        if (error.status === 401 || error.status === 404 || error.status === 410) {
          onErrorRef.current(error.message);
          return;
        }
        pollCount += 1;
        timer = setTimeout(poll, pollCount < 12 ? 5000 : 15000);
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
  hasRun,
  transferState,
  onTransfer,
  onReset,
}: {
  step: number;
  hasRun?: boolean;
  transferState?: string;
  onTransfer?: () => void;
  onReset: () => void;
}) {
  return (
    <header className="site-header">
      {hasRun ? (
        <span className="wordmark" aria-label="Needle">
          <span aria-hidden="true">[N]</span> NEEDLE_
        </span>
      ) : (
        <button className="wordmark" onClick={onReset} aria-label="Needle home">
          <span aria-hidden="true">[N]</span> NEEDLE_
        </button>
      )}
      <div className="header-meta">
        {hasRun && onTransfer && (
          <button className="transfer-button" onClick={onTransfer} disabled={transferState === "busy"}>
            {transferState === "copied" ? "LINK COPIED" : transferState === "busy" ? "CREATING..." : "TRANSFER RUN"}
          </button>
        )}
        <span aria-label={"Step " + step + " of 6"}>{String(step).padStart(2, "0")}/06</span>
        <a href="/owner">OWNER</a>
      </div>
    </header>
  );
}

function PromptScreen({
  prompt,
  busy,
  onPrompt,
  onSubmit,
}: {
  prompt: string;
  busy: boolean;
  onPrompt: (value: string) => void;
  onSubmit: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <section className="screen prompt-screen" aria-labelledby="prompt-title">
      <div className="screen-index">/ REQUEST</div>
      <h1 id="prompt-title">DEEP PLAYLIST<br />RESEARCH.</h1>
      <p className="landing-copy">Apple Music’s Playlist Playground suggests 25 tracks. Needle is for deeper work: Paulinho da Costa’s own biography credits him on more than 6,000 songs, so Needle researches the evidence and assembles the source-backed playlist.</p>
      <div className="source-links" aria-label="Landing claim sources">
        <a href="https://support.apple.com/en-lamr/118289" target="_blank" rel="noreferrer">APPLE SUPPORT ↗</a>
        <a href="https://paulinho.com/about/" target="_blank" rel="noreferrer">DA COSTA BIOGRAPHY ↗</a>
      </div>

      <form className="command-form" onSubmit={submit}>
        <label htmlFor="playlist-request">&gt; WHAT SHOULD WE FIND?</label>
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
            placeholder="Every released song..."
          />
        </div>
        <button className="action-button" disabled={busy || prompt.trim().length < 4}>
          {busy ? "INTERPRETING..." : "INTERPRET SCOPE →"}
        </button>
      </form>

      <div className="examples" aria-label="Example requests">
        <span>TRY:</span>
        {examples.map((example) => (
          <button key={example} onClick={() => onPrompt(example)}>{example}</button>
        ))}
      </div>
    </section>
  );
}

function BriefScreen({
  brief,
  estimate,
  cached,
  busy,
  onBack,
  onStart,
}: {
  brief: PlaylistBrief;
  estimate: number;
  cached: boolean;
  busy: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <section className="screen" aria-labelledby="brief-title">
      <div className="screen-index">/ SCOPE</div>
      <div className="title-row">
        <h1 id="brief-title">{brief.title}</h1>
        <span className="tag">[{brief.mode.toUpperCase()}]</span>
      </div>
      <p>{brief.description}</p>

      <dl className="scope-grid">
        <div><dt>SUBJECT</dt><dd>{brief.subjectEntities.join(", ") || "—"}</dd></div>
        <div><dt>RELATIONSHIP</dt><dd>{brief.relationship}</dd></div>
        <div><dt>VERSIONS</dt><dd>{brief.versionPolicy}</dd></div>
        <div><dt>ORDER</dt><dd>{brief.orderingPolicy || "Evidence confidence, then release date"}</dd></div>
        <div><dt>EVIDENCE</dt><dd>{brief.evidencePolicy}</dd></div>
        <div><dt>TARGET</dt><dd>{brief.targetSize ? brief.targetSize.min + "–" + brief.targetSize.max : "Source-bounded"}</dd></div>
      </dl>

      <div className="rule-block">
        <div><span>+</span><strong>INCLUDE</strong><p>{brief.include.join(" / ") || "All qualifying recordings"}</p></div>
        <div><span>−</span><strong>EXCLUDE</strong><p>{brief.exclude.join(" / ") || "Nothing beyond the stated scope"}</p></div>
      </div>

      {brief.ambiguities.length > 0 && (
        <details className="terminal-details" open>
          <summary>ASSUMPTIONS [{brief.ambiguities.length}]</summary>
          <ul>{brief.ambiguities.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      )}

      <div className="screen-actions">
        <button className="quiet-button" onClick={onBack}>← EDIT REQUEST</button>
        <div className="estimate">
          <span>{cached ? "CACHED RESULT" : "INITIAL COST EST."}</span>
          <strong>{cached ? "$0.00" : money(estimate)}</strong>
        </div>
        <button className="action-button" onClick={onStart} disabled={busy}>
          {busy ? "QUEUING..." : "CONFIRM + RESEARCH →"}
        </button>
      </div>
    </section>
  );
}

function RunScreen({ run, onReset }: { run: ResearchRun; onReset: () => void }) {
  const progress = progressByPhase[run.phase] ?? (run.status === "queued" ? 4 : 12);
  const showReset = terminalStatuses.has(run.status);

  return (
    <section className="screen" aria-labelledby="run-title">
      <div className="screen-index">/ RESEARCH</div>
      <div className="title-row">
        <h1 id="run-title">{run.brief.title}</h1>
        <span className="tag">[{statusLabel(run.status).toUpperCase()}]</span>
      </div>
      <p>{phaseMessage(run)}</p>

      <div className="progress" aria-label={"Research " + progress + "% complete"}>
        <span style={{ width: progress + "%" }} />
      </div>
      <div className="phase-line"><span className="cursor" aria-hidden="true">▋</span>{statusLabel(run.phase || run.status)}</div>

      <dl className="metric-grid">
        <div><dt>CANDIDATES</dt><dd>{numberValue(run.candidateCount)}</dd></div>
        <div><dt>SOURCES</dt><dd>{numberValue(run.sourceCount)}</dd></div>
        <div><dt>OPEN GAPS</dt><dd>{numberValue(run.unresolvedCount)}</dd></div>
        <div><dt>SPENT</dt><dd>{money(run.actualCostUsd)}</dd></div>
      </dl>

      {run.frontier?.length > 0 && (
        <div className="frontier" aria-label="Source frontier">
          <div className="frontier-head"><span>SOURCE / STRATEGY</span><span>FOUND</span><span>STATE</span></div>
          {run.frontier.slice(0, 8).map((item, index) => (
            <div key={item.sourceClass + item.strategy + index}>
              <span><strong>{item.sourceClass}</strong><small>{item.strategy}</small></span>
              <span>{item.recoveredCount}/{item.discoveredCount || "?"}</span>
              <span>[{item.status}]</span>
            </div>
          ))}
        </div>
      )}

      {showReset && <button className="quiet-button standalone" onClick={onReset}>← NEW REQUEST</button>}
    </section>
  );
}

function ReviewScreen({
  page,
  busy,
  onPage,
  onDecision,
  onManifest,
}: {
  page: ExceptionPage | null;
  busy: string;
  onPage: (page: number) => void;
  onDecision: (item: ExceptionItem, decision: "accepted" | "rejected", song?: CatalogSong) => void;
  onManifest: (verifiedOnly: boolean) => void;
}) {
  const unresolved = page?.unresolvedCount ?? 0;

  return (
    <section className="screen" aria-labelledby="review-title">
      <div className="screen-index">/ EXCEPTIONS</div>
      <div className="title-row">
        <h1 id="review-title">CHECK THE<br />UNCERTAIN TRACKS.</h1>
        <span className="tag">[{page?.total ?? "…"} TOTAL]</span>
      </div>
      <p>Exact matches are already accepted; unavailable, inferred, and conflicting recordings remain visible here.</p>

      {!page && <div className="loading-line" role="status"><span className="cursor">▋</span>LOADING EXCEPTIONS</div>}
      {page && page.items.length === 0 && <div className="empty-state">[NO EXCEPTIONS]</div>}
      {page && page.items.length > 0 && (
        <div className="exception-list">
          {page.items.map((item, index) => (
            <article className="exception-row" key={item.candidateId}>
              <div className="exception-number">{String((page.page - 1) * page.pageSize + index + 1).padStart(3, "0")}</div>
              <div className="exception-copy">
                <strong>{item.title}</strong>
                <span>{item.artist}{item.album ? " / " + item.album : ""}</span>
                <small>{item.basis || item.evidenceState || statusLabel(item.status)}</small>
              </div>
              <div className="exception-actions">
                {exceptionChoices(item).map((song) => (
                  <button
                    key={song.id}
                    onClick={() => onDecision(item, "accepted", song)}
                    disabled={Boolean(busy)}
                  >
                    USE: {song.name} / {song.artistName}
                  </button>
                ))}
                <button
                  className="reject"
                  onClick={() => onDecision(item, "rejected")}
                  disabled={Boolean(busy)}
                >
                  EXCLUDE
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {page && page.totalPages > 1 && (
        <nav className="pagination" aria-label="Exception pages">
          <button disabled={Boolean(busy) || page.page <= 1} onClick={() => onPage(page.page - 1)}>← PREV</button>
          <span>{String(page.page).padStart(2, "0")} / {String(page.totalPages).padStart(2, "0")}</span>
          <button disabled={Boolean(busy) || page.page >= page.totalPages} onClick={() => onPage(page.page + 1)}>NEXT →</button>
        </nav>
      )}

      <div className="screen-actions review-footer">
        <div className="estimate"><span>OPEN EXCEPTIONS</span><strong>{unresolved}</strong></div>
        {unresolved > 0 && (
          <button className="quiet-button" onClick={() => onManifest(true)} disabled={!page || Boolean(busy)}>
            SKIP OPEN + PUBLISH VERIFIED
          </button>
        )}
        <button className="action-button" onClick={() => onManifest(false)} disabled={!page || Boolean(busy) || unresolved > 0}>
          {busy === "manifest" ? "LOCKING..." : "LOCK REVIEWED MANIFEST →"}
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
    <section className="screen" aria-labelledby="manifest-title">
      <div className="screen-index">/ MANIFEST</div>
      <div className="title-row">
        <h1 id="manifest-title">{trackCount.toLocaleString()} TRACKS<br />LOCKED.</h1>
        <span className="tag">[{volumeCount} {volumeCount === 1 ? "VOLUME" : "VOLUMES"}]</span>
      </div>
      <p>{waitingForApple
        ? "The manifest is safe; publication resumes after the owner reconnects Apple Music."
        : publishing
          ? "Needle is publishing the locked catalog IDs in deterministic batches."
          : "Apple Music will receive exactly these catalog IDs in this order; research can no longer alter the manifest."}</p>

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
        <div className="empty-state">[ORDERED MANIFEST LOCKED ON SERVER]</div>
      )}

      {manifest.contentHash && <code className="manifest-hash">SHA256/{manifest.contentHash.slice(0, 20)}…</code>}
      <button className="action-button publish-button" onClick={onPublish} disabled={busy}>
        {waitingForApple
          ? "WAITING FOR APPLE AUTHORIZATION"
          : publishing || busy
            ? "PUBLICATION IN PROGRESS..."
            : "PUBLISH TO APPLE MUSIC →"}
      </button>
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
    <section className="screen" aria-labelledby="result-title">
      <div className="screen-index">/ RESULT</div>
      <div className="title-row">
        <h1 id="result-title">{result.status === "partial" ? "PUBLISHED WITH GAPS." : "PUBLISHED."}</h1>
        <span className="tag">[{result.volumes.length} {result.volumes.length === 1 ? "VOLUME" : "VOLUMES"}]</span>
      </div>
      <p>{result.coverageSummary || "The Apple Music links and source-bounded coverage report are ready."}</p>
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

      <dl className="result-grid">
        <div><dt>SOURCES</dt><dd>{numberValue(result.sourceCount)}</dd></div>
        <div><dt>OPEN GAPS</dt><dd>{numberValue(result.unresolvedGapCount)}</dd></div>
        {outcomes.slice(0, 4).map(([label, value]) => (
          <div key={label}><dt>{statusLabel(label).toUpperCase()}</dt><dd>{value}</dd></div>
        ))}
      </dl>

      <div className="screen-actions result-actions">
        <button className="quiet-button" onClick={onReset}>← NEW REQUEST</button>
        {result.evidenceUrl && <a className="quiet-link" href={result.evidenceUrl} target="_blank" rel="noreferrer">VIEW EVIDENCE ↗</a>}
        <button className="text-danger" onClick={onDelete}>DELETE RUN DATA</button>
      </div>
    </section>
  );
}

export function PlaylistBuilder() {
  const [prompt, setPrompt] = useState("");
  const [brief, setBrief] = useState<PlaylistBrief | null>(null);
  const [briefRequestId, setBriefRequestId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState(0);
  const [cached, setCached] = useState(false);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [exceptionPage, setExceptionPage] = useState<ExceptionPage | null>(null);
  const [manifest, setManifest] = useState<PlaylistManifest | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [transferState, setTransferState] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const briefIdempotencyKey = useRef<string | null>(null);
  const publishingRef = useRef(false);
  const reviewingRef = useRef(false);

  const reset = useCallback(() => {
    setPrompt("");
    setBrief(null);
    setBriefRequestId(null);
    setEstimate(0);
    setCached(false);
    setRun(null);
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

  const updateRun = useCallback((next: ResearchRun) => {
    setRun(next);
    if (next.status === "failed" && next.error) setError(next.error);
  }, []);

  useRunPolling(run?.id ?? null, run?.status ?? null, updateRun, setError);

  const loadRun = useCallback(async (runId: string) => {
    const next = unwrapRun(await api<ResearchRun | RunResponse>("/api/v1/runs/" + encodeURIComponent(runId)));
    setRun(next);
    setBrief(next.brief);
    setPrompt(next.prompt);
  }, []);

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
          setEstimate(numberValue(response.estimateUsd ?? response.estimatedCostUsd));
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
        if (!storedManifest) throw new Error("The locked manifest could not be restored.");
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
      setEstimate(numberValue(response.estimateUsd ?? response.estimatedCostUsd));
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
    setBusy("run");
    setError("");
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    try {
      const response = await api<ResearchRun | RunResponse>("/api/v1/runs", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({
          briefRequestId,
          brief: briefRequestId ? undefined : brief,
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
        <AppHeader step={1} onReset={reset} />
        <section className="screen restore-screen" role="status">
          <span className="cursor" aria-hidden="true">▋</span>RESTORING RUN
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AppHeader
        step={step}
        hasRun={Boolean(run)}
        transferState={transferState}
        onTransfer={transferRun}
        onReset={reset}
      />
      {error && (
        <div className="error-bar" role="alert">
          <span>[ERROR]</span>
          <p>{error}</p>
          <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
        </div>
      )}

      {!brief && (
        <PromptScreen
          prompt={prompt}
          busy={busy === "brief"}
          onPrompt={(value) => {
            setPrompt(value);
            briefIdempotencyKey.current = null;
          }}
          onSubmit={interpret}
        />
      )}

      {brief && !run && (
        <BriefScreen
          brief={brief}
          estimate={estimate}
          cached={cached}
          busy={busy === "run"}
          onBack={() => {
            setBrief(null);
            setBriefRequestId(null);
            idempotencyKey.current = null;
            window.history.replaceState(null, "", window.location.pathname);
          }}
          onStart={startResearch}
        />
      )}

      {run && reviewStatuses.has(run.status) && !manifest && (
        <ReviewScreen
          page={exceptionPage}
          busy={busy}
          onPage={loadExceptions}
          onDecision={review}
          onManifest={buildManifest}
        />
      )}

      {run && !reviewStatuses.has(run.status) && !manifest && !result && (
        <RunScreen run={run} onReset={reset} />
      )}

      {manifest && !result && (
        <ManifestScreen
          manifest={manifest}
          runStatus={run?.status ?? "manifest_ready"}
          busy={busy === "publish" || ["publishing", "waiting_for_apple_authorization"].includes(run?.status ?? "")}
          onPublish={publish}
        />
      )}

      {result && <ResultScreen result={result} onReset={reset} onDelete={deleteRun} />}

      <footer className="site-footer">
        <span>EXHAUSTIVE ACROSS DOCUMENTED SOURCES.</span>
        <span>UNRESOLVED GAPS STAY VISIBLE.</span>
      </footer>
    </main>
  );
}
