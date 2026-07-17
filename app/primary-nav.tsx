"use client";

import Link from "next/link";

export type PrimaryNavItem = "create" | "explore" | "jobs";

export function PrimaryNav({
  active,
  onCreate,
  onJobs,
}: {
  active?: PrimaryNavItem;
  onCreate?: () => void;
  onJobs?: () => void;
}) {
  return (
    <nav className="primary-nav" aria-label="Primary navigation">
      <Link
        data-nav-item="create"
        className={active === "create" ? "is-current" : undefined}
        href="/"
        aria-current={active === "create" ? "page" : undefined}
        onClick={(event) => {
          if (!onCreate) return;
          event.preventDefault();
          onCreate();
        }}
      >
        CREATE
      </Link>
      <Link
        data-nav-item="explore"
        className={active === "explore" ? "is-current" : undefined}
        href="/playlists"
        aria-current={active === "explore" ? "page" : undefined}
      >
        EXPLORE
      </Link>
      {onJobs ? (
        <button data-nav-item="jobs" className={active === "jobs" ? "is-current" : undefined} type="button" onClick={onJobs} aria-current={active === "jobs" ? "page" : undefined}>
          JOBS
        </button>
      ) : (
        <Link data-nav-item="jobs" className={active === "jobs" ? "is-current" : undefined} href="/?view=jobs" aria-current={active === "jobs" ? "page" : undefined}>
          JOBS
        </Link>
      )}
    </nav>
  );
}
