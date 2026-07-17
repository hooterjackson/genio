"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrandWordmark } from "../brand-wordmark";
import { PrimaryNav } from "../primary-nav";
import { SiteMenu } from "../site-menu";

type PublicPlaylistVolume = {
  volumeNumber: number;
  name: string;
  trackCount: number;
  shareUrl: string;
};

type PublicPlaylist = {
  id: string;
  title: string;
  trackCount: number;
  volumeCount: number;
  publishedAt: string;
  volumes: PublicPlaylistVolume[];
};

type DirectoryResponse = {
  items: PublicPlaylist[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 12;

function initialPage(): number {
  if (typeof window === "undefined") return 1;
  const value = Number.parseInt(new URLSearchParams(window.location.search).get("page") ?? "1", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function applePlaylistUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "music.apple.com"
      && /\/playlist\//iu.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publishedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date).toUpperCase();
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${Math.max(0, count).toLocaleString()} ${count === 1 ? singular : plural}`;
}

function DirectoryHeader() {
  return (
    <header className="site-header directory-header">
      <Link className="wordmark ascii-wordmark" href="/" aria-label="gênio home">
        <BrandWordmark />
      </Link>
      <div className="header-meta">
        <PrimaryNav active="explore" />
        <SiteMenu />
      </div>
    </header>
  );
}

function DirectoryLoading() {
  return (
    <div className="directory-loading" role="status" aria-label="Loading public playlists" aria-live="polite">
      <span><i aria-hidden="true" /></span>
      <span><i aria-hidden="true" /></span>
      <span><i aria-hidden="true" /></span>
      <span className="sr-only">Loading public playlists</span>
    </div>
  );
}

export function PlaylistDirectory() {
  const [page, setPage] = useState(initialPage);
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    void fetch(`/api/v1/playlists?${query.toString()}`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Directory request failed (${response.status})`);
        return response.json() as Promise<DirectoryResponse>;
      })
      .then((payload) => {
        if (!Array.isArray(payload.items)) throw new Error("Directory response was invalid");
        const totalPages = Math.max(1, Number.isFinite(payload.totalPages) ? payload.totalPages : 1);
        if (page > totalPages && payload.total > 0) {
          setLoading(true);
          setPage(totalPages);
          return;
        }
        setDirectory({
          ...payload,
          page,
          pageSize: PAGE_SIZE,
          total: Math.max(0, payload.total),
          totalPages,
        });
      })
      .catch((caught: unknown) => {
        if ((caught as Error).name !== "AbortError") setError("Public playlists could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [page, retryKey]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (page === 1) url.searchParams.delete("page");
    else url.searchParams.set("page", String(page));
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [page]);

  const goToPage = useCallback((nextPage: number) => {
    setLoading(true);
    setError("");
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError("");
    setRetryKey((value) => value + 1);
  }, []);

  const playlistCount = useMemo(
    () => directory ? countLabel(directory.total, "PUBLIC PLAYLIST", "PUBLIC PLAYLISTS") : "PUBLIC PLAYLISTS",
    [directory],
  );

  return (
    <main className="app-shell directory-shell">
      <DirectoryHeader />
      <section className="directory-screen" aria-labelledby="directory-title">
        <header className="directory-intro">
          <h1 id="directory-title">Explore playlists</h1>
          <p>Explore playlists researched and published by gênio.</p>
          <small>{playlistCount}</small>
        </header>

        {loading && <DirectoryLoading />}

        {!loading && error && (
          <div className="directory-state directory-error" role="alert">
            <strong>PLAYLISTS COULD NOT BE LOADED.</strong>
            <p>Check your connection, then try again.</p>
            <button type="button" onClick={retry}>RETRY →</button>
          </div>
        )}

        {!loading && !error && directory?.items.length === 0 && (
          <div className="directory-state">
            <strong>NO PLAYLISTS YET.</strong>
            <p>Published playlists will appear here.</p>
            <Link href="/">CREATE THE FIRST ONE →</Link>
          </div>
        )}

        {!loading && !error && directory && directory.items.length > 0 && (
          <>
            <ol className="directory-list" start={(directory.page - 1) * directory.pageSize + 1}>
              {directory.items.map((playlist) => {
                const validVolumes = playlist.volumes
                  .map((volume) => ({ ...volume, safeUrl: applePlaylistUrl(volume.shareUrl) }))
                  .filter((volume) => volume.safeUrl !== null)
                  .sort((left, right) => left.volumeNumber - right.volumeNumber);
                const missingVolumeCount = Math.max(0, playlist.volumes.length - validVolumes.length);
                return (
                  <li key={playlist.id}>
                    <article className="directory-playlist">
                      <div className="directory-playlist-index" aria-hidden="true" />
                      <div className="directory-playlist-copy">
                        <time dateTime={playlist.publishedAt}>{publishedDate(playlist.publishedAt)}</time>
                        <h2>{playlist.title}</h2>
                        <p>
                          {countLabel(playlist.trackCount, "TRACK", "TRACKS")}
                          <span aria-hidden="true"> · </span>
                          {countLabel(playlist.volumeCount, "VOLUME", "VOLUMES")}
                        </p>
                      </div>
                      <div className="directory-volume-links">
                        {validVolumes.map((volume) => (
                          <a
                            key={`${playlist.id}-${volume.volumeNumber}`}
                            href={volume.safeUrl ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${volume.name} in Apple Music`}
                          >
                            <span>{playlist.volumeCount > 1 ? `VOLUME ${volume.volumeNumber}` : "APPLE MUSIC"}</span>
                            <small>{countLabel(volume.trackCount, "track", "tracks")}</small>
                            <b aria-hidden="true">↗</b>
                          </a>
                        ))}
                        {validVolumes.length === 0 && <span className="directory-link-missing">APPLE LINK UNAVAILABLE</span>}
                        {validVolumes.length > 0 && missingVolumeCount > 0 && (
                          <span className="directory-link-missing">
                            {missingVolumeCount} APPLE {missingVolumeCount === 1 ? "LINK" : "LINKS"} UNAVAILABLE
                          </span>
                        )}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>

            {directory.totalPages > 1 && (
              <nav className="directory-pagination" aria-label="Playlist directory pages">
                <button
                  type="button"
                  disabled={directory.page <= 1}
                  onClick={() => goToPage(directory.page - 1)}
                >
                  ← PREVIOUS
                </button>
                <span aria-live="polite">PAGE {directory.page} / {directory.totalPages}</span>
                <button
                  type="button"
                  disabled={directory.page >= directory.totalPages}
                  onClick={() => goToPage(directory.page + 1)}
                >
                  NEXT →
                </button>
              </nav>
            )}
          </>
        )}
      </section>
    </main>
  );
}
