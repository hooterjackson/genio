"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { configureFreshMusicKit, type MusicKitApi, type MusicKitInstance } from "../music-kit.ts";
import {
  appleAuthorizationErrorMessage,
  durableAppleAuthorizationMessage,
  requireMusicUserToken,
  waitForDurableAppleAuthorization,
} from "./apple-authorization-status.ts";

type OwnerHealth = {
  ok: boolean;
  paused: boolean;
  database: "ready" | "down";
  worker: "healthy" | "stale" | "missing";
  apple: {
    configured: boolean;
    authorized: boolean;
    storefront: string | null;
    validatedAt: string | null;
    needsReauthorization: boolean;
  };
  queuedJobs: number;
  activeJobs: number;
  monthSpendUsd: number;
  monthReservedUsd: number;
  notificationBacklog: number;
  orphanedPlaylists: number;
};

type BudgetItem = {
  id?: string;
  runId: string;
  title?: string;
  prompt?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  approvedBudgetUsd?: number;
  requestedBudgetUsd?: number;
  expiresAt?: string;
};

type OrphanItem = {
  id: string;
  name?: string;
  applePlaylistId?: string | null;
  shareUrl?: string | null;
  error?: string | null;
  createdAt?: string;
};

type RecentRun = {
  id: string;
  title: string;
  status: string;
  phase: string;
  completedAt?: string | null;
  createdAt?: string;
};

type AppleTokenResponse = {
  developerToken: string;
  mediaId?: string;
  expiresAt?: string;
};

type PreparedAppleAuthorization = {
  music: MusicKitInstance;
  token: AppleTokenResponse;
};

type AppleConnectorState = "preparing" | "ready" | "failed";

// MusicKit v3 currently completes Apple's consent UI and then rejects
// authorize() with AUTHORIZATION_ERROR/Unauthorized before returning a user
// token. Keep owner authorization on Apple's stable v2 build; unlike v1 it
// requests a token without first preloading the protected audio player. The
// HTTP Apple Music API used by the server remains unchanged.
const MUSICKIT_SRC = "https://js-cdn.music.apple.com/musickit/v2/musickit.js";
let musicKitPromise: Promise<MusicKitApi> | null = null;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayFrom<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const object = asObject(payload);
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as T[];
  }
  return [];
}

function normalizeBudgets(payload: unknown): BudgetItem[] {
  return arrayFrom<unknown>(payload, ["items", "runs", "budgets"]).flatMap((raw) => {
    const item = asObject(raw);
    const brief = asObject(item.brief);
    const runId = typeof item.runId === "string"
      ? item.runId
      : typeof item.id === "string"
        ? item.id
        : "";
    if (!runId) return [];
    return [{
      id: typeof item.id === "string" ? item.id : runId,
      runId,
      title: typeof brief.title === "string"
        ? brief.title
        : typeof item.title === "string"
          ? item.title
          : undefined,
      prompt: typeof item.prompt === "string" ? item.prompt : undefined,
      estimatedCostUsd: typeof item.estimatedCostUsd === "number" ? item.estimatedCostUsd : undefined,
      actualCostUsd: typeof item.actualCostUsd === "number" ? item.actualCostUsd : undefined,
      approvedBudgetUsd: typeof item.approvedBudgetUsd === "number" ? item.approvedBudgetUsd : undefined,
      requestedBudgetUsd: typeof item.requestedBudgetUsd === "number" ? item.requestedBudgetUsd : undefined,
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : undefined,
    }];
  });
}

function normalizeOrphans(payload: unknown): OrphanItem[] {
  return arrayFrom<unknown>(payload, ["items", "volumes", "orphans"]).flatMap((raw) => {
    const item = asObject(raw);
    if (typeof item.id !== "string") return [];
    return [{
      id: item.id,
      name: typeof item.name === "string" ? item.name : undefined,
      applePlaylistId: typeof item.applePlaylistId === "string"
        ? item.applePlaylistId
        : typeof item.apple_playlist_id === "string"
          ? item.apple_playlist_id
          : null,
      shareUrl: typeof item.shareUrl === "string"
        ? item.shareUrl
        : typeof item.apple_share_url === "string"
          ? item.apple_share_url
          : null,
      error: typeof item.error === "string"
        ? item.error
        : typeof item.reason === "string"
          ? item.reason
          : null,
      createdAt: typeof item.createdAt === "string"
        ? item.createdAt
        : typeof item.created_at === "string"
          ? item.created_at
          : undefined,
    }];
  });
}

function normalizeRecentRuns(payload: unknown): RecentRun[] {
  return arrayFrom<unknown>(payload, ["items", "runs"]).flatMap((raw) => {
    const item = asObject(raw);
    if (typeof item.id !== "string") return [];
    return [{
      id: item.id,
      title: typeof item.title === "string" ? item.title : "Untitled run",
      status: typeof item.status === "string" ? item.status : "unknown",
      phase: typeof item.phase === "string" ? item.phase : "unknown",
      completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    }];
  });
}

function nextBudgetAmount(item: BudgetItem): number {
  if (typeof item.requestedBudgetUsd === "number") return item.requestedBudgetUsd;
  const estimated = item.estimatedCostUsd ?? 0;
  const approved = item.approvedBudgetUsd ?? 0;
  const actual = item.actualCostUsd ?? 0;
  return Math.max(estimated, approved > 0 ? approved * 2 : 0, actual + 1, 5);
}

async function ownerApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, credentials: "include", headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const object = asObject(payload);
    throw new Error(typeof object.error === "string" ? object.error : "Owner request failed (" + response.status + ")");
  }
  return payload as T;
}

function loadMusicKit(): Promise<MusicKitApi> {
  const musicWindow = window as unknown as { MusicKit?: MusicKitApi };
  if (musicWindow.MusicKit) return Promise.resolve(musicWindow.MusicKit);
  if (musicKitPromise) return musicKitPromise;

  musicKitPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-needle-musickit="true"]');
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(() => {
      musicKitPromise = null;
      reject(new Error("Apple Music authorization timed out."));
    }, 15_000);
    const ready = () => {
      if (!musicWindow.MusicKit) return;
      window.clearTimeout(timeout);
      resolve(musicWindow.MusicKit);
    };
    script.addEventListener("load", ready, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timeout);
      musicKitPromise = null;
      reject(new Error("Apple MusicKit could not load."));
    }, { once: true });
    if (!existing) {
      script.src = MUSICKIT_SRC;
      script.async = true;
      script.dataset.needleMusickit = "true";
      document.head.appendChild(script);
    }
    const poll = window.setInterval(() => {
      if (!musicWindow.MusicKit) return;
      window.clearInterval(poll);
      ready();
    }, 100);
    window.setTimeout(() => window.clearInterval(poll), 15_100);
  });

  return musicKitPromise;
}

async function prepareAppleAuthorization(): Promise<PreparedAppleAuthorization> {
  const token = await ownerApi<AppleTokenResponse>("/api/v1/owner/apple/developer-token");
  const MusicKit = await loadMusicKit();
  return {
    music: await configureFreshMusicKit(MusicKit, token.developerToken),
    token,
  };
}

function appleDeveloperTokenIsFresh(token: AppleTokenResponse, minimumLifetimeMs = 120_000): boolean {
  const expiresAt = Date.parse(token.expiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > minimumLifetimeMs;
}

export function OwnerConsole({ email, signOutPath }: { email: string; signOutPath: string }) {
  const [health, setHealth] = useState<OwnerHealth | null>(null);
  const [budgets, setBudgets] = useState<BudgetItem[]>([]);
  const [orphans, setOrphans] = useState<OrphanItem[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [importRunId, setImportRunId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [appleStatusMessage, setAppleStatusMessage] = useState("CHECKING APPLE MUSIC STATUS");
  const [appleConnectorState, setAppleConnectorState] = useState<AppleConnectorState>("preparing");
  const [appleConnectorError, setAppleConnectorError] = useState("");
  const [applePreparationAttempt, setApplePreparationAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const preparedAppleAuthorization = useRef<PreparedAppleAuthorization | null>(null);

  const restartAppleConnector = useCallback(() => {
    preparedAppleAuthorization.current = null;
    setAppleConnectorState("preparing");
    setAppleConnectorError("");
    setApplePreparationAttempt((current) => current + 1);
  }, []);

  async function refresh() {
    setBusy((current) => current || "refresh");
    const [healthResult, budgetResult, orphanResult, runResult] = await Promise.allSettled([
      ownerApi<OwnerHealth>("/api/v1/owner/status"),
      ownerApi<unknown>("/api/v1/owner/budgets"),
      ownerApi<unknown>("/api/v1/owner/publications/orphans"),
      ownerApi<unknown>("/api/v1/owner/runs?limit=50"),
    ]);

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setAppleStatusMessage(healthResult.value.apple.authorized
        ? `APPLE MUSIC CONNECTED · ${healthResult.value.apple.storefront?.toUpperCase() ?? "UNKNOWN STOREFRONT"} · TOKEN SAVED AND VALIDATED`
        : healthResult.value.apple.needsReauthorization
          ? "APPLE MUSIC AUTHORIZATION EXPIRED · AUTHORIZE AGAIN"
          : "APPLE MUSIC IS NOT CONNECTED");
      setError("");
    } else {
      setError(healthResult.reason instanceof Error ? healthResult.reason.message : "Owner status is unavailable.");
    }
    if (budgetResult.status === "fulfilled") {
      setBudgets(normalizeBudgets(budgetResult.value));
    }
    if (orphanResult.status === "fulfilled") {
      setOrphans(normalizeOrphans(orphanResult.value));
    }
    if (runResult.status === "fulfilled") {
      const runs = normalizeRecentRuns(runResult.value);
      setRecentRuns(runs);
      setImportRunId((current) => current || runs.find((run) => ["queued", "awaiting_budget", "researching", "ready_for_matching"].includes(run.status))?.id || "");
    }
    setBusy("");
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshRequested = false;
    let tokenRefreshTimer: number | undefined;
    const requestFreshConnector = () => {
      if (cancelled || refreshRequested) return;
      refreshRequested = true;
      restartAppleConnector();
    };
    const refreshIfStale = () => {
      const prepared = preparedAppleAuthorization.current;
      if (!prepared || !appleDeveloperTokenIsFresh(prepared.token)) requestFreshConnector();
    };

    void prepareAppleAuthorization().then((prepared) => {
      if (cancelled) return;
      preparedAppleAuthorization.current = prepared;
      setAppleConnectorState("ready");
      const expiresAt = Date.parse(prepared.token.expiresAt ?? "");
      const refreshDelay = Number.isFinite(expiresAt)
        ? Math.max(1_000, expiresAt - Date.now() - 120_000)
        : 10 * 60_000;
      tokenRefreshTimer = window.setTimeout(requestFreshConnector, refreshDelay);
    }).catch((caught) => {
      if (cancelled) return;
      preparedAppleAuthorization.current = null;
      setAppleConnectorState("failed");
      setAppleConnectorError(`Apple Music connector could not load: ${appleAuthorizationErrorMessage(caught)}`);
    });
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      cancelled = true;
      if (tokenRefreshTimer) window.clearTimeout(tokenRefreshTimer);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [applePreparationAttempt, restartAppleConnector]);

  async function authorizeApple() {
    setBusy("apple");
    setError("");
    setAppleStatusMessage("APPLE MUSIC AUTHORIZATION IN PROGRESS");
    try {
      const prepared = preparedAppleAuthorization.current;
      if (!prepared) {
        throw new Error("Apple Music is still preparing. Wait for the authorization button to become available.");
      }
      if (!appleDeveloperTokenIsFresh(prepared.token, 30_000)) {
        restartAppleConnector();
        throw new Error("Apple Music setup expired. Wait for the authorization button to become available, then try again.");
      }
      // Start authorization before the first await so Apple receives the
      // browser's trusted click and may open its consent window.
      const authorizationPromise = prepared.music.authorize();
      let authorizationResult: unknown;
      try {
        authorizationResult = await authorizationPromise;
      } catch (caught) {
        throw new Error(`Apple Music did not issue a user token: ${appleAuthorizationErrorMessage(caught)}`);
      }
      const musicUserToken = requireMusicUserToken(authorizationResult);
      // Consent may stay open until the prepared token is near expiry. Use a
      // newly issued developer token for the authenticated storefront read.
      const storefrontToken = await ownerApi<AppleTokenResponse>("/api/v1/owner/apple/developer-token");
      const storefrontResponse = await fetch("https://api.music.apple.com/v1/me/storefront", {
        headers: {
          Authorization: "Bearer " + storefrontToken.developerToken,
          "Music-User-Token": musicUserToken,
        },
      });
      const storefrontPayload = await storefrontResponse.json().catch(() => ({}));
      const storefront = asObject(Array.isArray(storefrontPayload.data) ? storefrontPayload.data[0] : {}).id;
      if (!storefrontResponse.ok || typeof storefront !== "string") {
        throw new Error("Apple did not return the owner storefront.");
      }
      await ownerApi("/api/v1/owner/apple/authorization", {
        method: "POST",
        body: JSON.stringify({ musicUserToken, storefront }),
      });
      const authorization = await waitForDurableAppleAuthorization(
        () => ownerApi("/api/v1/owner/apple/authorization"),
      );
      await refresh();
      setAppleStatusMessage(durableAppleAuthorizationMessage(authorization));
    } catch (caught) {
      await refresh();
      setError(appleAuthorizationErrorMessage(caught));
      restartAppleConnector();
    } finally {
      setBusy("");
    }
  }

  async function revokeApple() {
    if (!window.confirm("Revoke Needle’s saved Apple Music authorization? Publication will pause.")) return;
    setBusy("apple");
    try {
      await ownerApi("/api/v1/owner/apple/authorization", { method: "DELETE" });
      await refresh();
      setAppleStatusMessage("APPLE MUSIC IS NOT CONNECTED");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function setPaused(paused: boolean) {
    setBusy("pause");
    try {
      await ownerApi("/api/v1/owner/emergency-pause", {
        method: "POST",
        body: JSON.stringify({ paused, researchPaused: paused, publishingPaused: paused }),
      });
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function decideBudget(item: BudgetItem, decision: "approve" | "cancel") {
    const amount = nextBudgetAmount(item);
    setBusy("budget-" + item.runId);
    try {
      await ownerApi("/api/v1/owner/runs/" + encodeURIComponent(item.runId) + "/budget", {
        method: "POST",
        body: JSON.stringify({
          decision,
          approvedBudgetUsd: decision === "approve" ? amount : undefined,
        }),
      });
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function invalidateCache(run: RecentRun) {
    if (!window.confirm(`Force the next “${run.title}” request to start fresh research?`)) return;
    setBusy("refresh-" + run.id);
    setError("");
    try {
      await ownerApi("/api/v1/owner/runs/" + encodeURIComponent(run.id) + "/refresh", { method: "POST" });
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function importCatalogue() {
    if (!importRunId || !importFile) return;
    if (!health?.paused) {
      setError("Pause the application before importing a specialist catalogue.");
      return;
    }
    if (importFile.size > 24 * 1024) {
      setError("Split this catalogue into files smaller than 24 KiB for the signed gateway.");
      return;
    }
    setBusy("catalog-import");
    setError("");
    setImportStatus("");
    try {
      const text = await importFile.text();
      const isJson = importFile.name.toLowerCase().endsWith(".json");
      const data = isJson ? JSON.parse(text) : text;
      if (isJson && !Array.isArray(data)) throw new Error("JSON catalogues must contain one array of track rows.");
      const result = await ownerApi<{ candidateCount: number; newlyAdded: number }>(
        "/api/v1/owner/runs/" + encodeURIComponent(importRunId) + "/catalog-import",
        {
          method: "POST",
          body: JSON.stringify({ format: isJson ? "json" : "csv", data }),
        },
      );
      setImportStatus(`${result.candidateCount} rows accepted; ${result.newlyAdded} new recordings.`);
      setImportFile(null);
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <Link className="wordmark" href="/"><span>[N]</span> NEEDLE_</Link>
        <div className="header-meta"><span>{email}</span><a href={signOutPath}>SIGN OUT</a></div>
      </header>
      <section className="owner-shell">
        <div className="screen-index">/ OWNER CONSOLE</div>
        <h1>SYSTEM<br />CONTROL.</h1>
        <p>Apple authorization, spending, and worker health are controlled here; visitor publication never waits for owner approval.</p>
        <Link className="quiet-link" href="/">TEST PLAYLIST FLOW →</Link>

        {error && (
          <div className="error-bar" role="alert">
            <span>[ERROR]</span><p>{error}</p><button onClick={() => setError("")} aria-label="Dismiss error">×</button>
          </div>
        )}

        <div className="operator-grid">
          <article className="operator-card">
            <span>WORKER</span>
            <strong>{health?.worker?.toUpperCase() ?? "CHECKING"}</strong>
            <small>{health?.database?.toUpperCase() ?? "—"} database</small>
          </article>
          <article className="operator-card">
            <span>QUEUE</span>
            <strong>{health?.queuedJobs ?? "—"}</strong>
            <small>{health?.activeJobs ?? "—"} active</small>
          </article>
          <article className="operator-card">
            <span>APPLE MUSIC</span>
            <strong>{health?.apple?.authorized ? "AUTHORIZED" : "OFFLINE"}</strong>
            <small>{health?.apple?.storefront?.toUpperCase() ?? "—"} storefront</small>
          </article>
          <article className="operator-card">
            <span>MONTH SPEND</span>
            <strong>{"$" + (health?.monthSpendUsd ?? 0).toFixed(2)}</strong>
            <small>{"$" + (health?.monthReservedUsd ?? 0).toFixed(2)} reserved</small>
          </article>
          <article className="operator-card">
            <span>BUDGET REVIEWS</span>
            <strong>{budgets.length}</strong>
            <small>over $5</small>
          </article>
          <article className="operator-card">
            <span>APPLICATION</span>
            <strong>{health?.paused ? "PAUSED" : "RUNNING"}</strong>
            <small>{health?.notificationBacklog ?? "—"} alerts queued</small>
          </article>
        </div>

        <div className="operator-actions">
          <button onClick={() => void refresh()} disabled={Boolean(busy)}>REFRESH</button>
          <button
            onClick={() => appleConnectorState === "failed"
              ? restartAppleConnector()
              : void authorizeApple()}
            disabled={Boolean(busy) || appleConnectorState === "preparing"}
          >
            {appleConnectorState === "preparing"
              ? "PREPARING APPLE"
              : appleConnectorState === "failed"
                ? "RETRY APPLE SETUP"
              : health?.apple?.authorized && !health.apple.needsReauthorization
                ? "REAUTHORIZE APPLE"
                : "AUTHORIZE APPLE"}
          </button>
          {health?.apple?.authorized && <button onClick={() => void revokeApple()} disabled={Boolean(busy)}>REVOKE APPLE</button>}
          <button className="danger-control" onClick={() => void setPaused(!health?.paused)} disabled={Boolean(busy)}>
            {health?.paused ? "RESUME APPLICATION" : "EMERGENCY PAUSE"}
          </button>
        </div>
        <p className="operator-note" role="status">
          {appleConnectorError || appleStatusMessage}
        </p>

        <section className="operator-section" aria-labelledby="budgets-title">
          <div className="operator-section-title"><h2 id="budgets-title">AWAITING BUDGET</h2><span>[{budgets.length}]</span></div>
          {budgets.length === 0 && <div className="operator-empty">NO RUNS ARE WAITING.</div>}
          {budgets.map((item) => {
            const amount = nextBudgetAmount(item);
            return (
              <article className="operator-row" key={item.id ?? item.runId}>
                <div><strong>{item.title || item.prompt || item.runId}</strong><small>{item.runId}</small></div>
                <span>{"$" + amount.toFixed(2)}</span>
                <div>
                  <button disabled={Boolean(busy)} onClick={() => void decideBudget(item, "approve")}>APPROVE</button>
                  <button disabled={Boolean(busy)} onClick={() => void decideBudget(item, "cancel")}>CANCEL</button>
                </div>
              </article>
            );
          })}
        </section>

        <section className="operator-section" aria-labelledby="orphans-title">
          <div className="operator-section-title"><h2 id="orphans-title">ORPHAN / TEST PLAYLISTS</h2><span>[{orphans.length}]</span></div>
          {orphans.length === 0 && <div className="operator-empty">NO MANUAL CLEANUP REQUIRED.</div>}
          {orphans.map((item) => (
            <article className="operator-row" key={item.id}>
              <div><strong>{item.name || item.applePlaylistId || item.id}</strong><small>{item.error || "Remove manually from the owner Apple Music library."}</small></div>
              <span>ORPHAN</span>
              <div>{item.shareUrl && <a href={item.shareUrl} target="_blank" rel="noreferrer">OPEN ↗</a>}</div>
            </article>
          ))}
        </section>

        <section className="operator-section" aria-labelledby="runs-title">
          <div className="operator-section-title"><h2 id="runs-title">RECENT RUNS</h2><span>[{recentRuns.length}]</span></div>
          <div className="operator-import">
            <select value={importRunId} onChange={(event) => setImportRunId(event.target.value)} aria-label="Run for catalogue import">
              <option value="">SELECT A PRE-MATCHING RUN</option>
              {recentRuns.filter((run) => ["queued", "awaiting_budget", "researching", "ready_for_matching"].includes(run.status)).map((run) => (
                <option key={run.id} value={run.id}>{run.title} / {run.status}</option>
              ))}
            </select>
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
              aria-label="CSV or JSON catalogue"
            />
            <button onClick={() => void importCatalogue()} disabled={Boolean(busy) || !importRunId || !importFile}>IMPORT CATALOGUE</button>
            <small>Pause first. Every row needs a public source URL; imports remain inferred until reviewed. Maximum 24 KiB per batch.</small>
            {importStatus && <strong>{importStatus}</strong>}
          </div>
          {recentRuns.length === 0 && <div className="operator-empty">NO RUNS YET.</div>}
          {recentRuns.map((run) => (
            <article className="operator-row" key={run.id}>
              <div><strong>{run.title}</strong><small>{run.id}</small></div>
              <span>{run.status.toUpperCase()}</span>
              <div>{["complete", "partial"].includes(run.status) && <button disabled={Boolean(busy)} onClick={() => void invalidateCache(run)}>FORCE NEXT REFRESH</button>}</div>
            </article>
          ))}
        </section>
      </section>
      <footer className="site-footer"><span>OWNER IDENTITY: CHATGPT</span><span>ALLOWLIST: EXACT EMAIL</span></footer>
    </main>
  );
}
