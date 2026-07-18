"use client";

import Link from "next/link";
import { BrandWordmark } from "./brand-wordmark";
import { PrimaryNav, type PrimaryNavItem } from "./primary-nav";
import { SiteMenu } from "./site-menu";

export type PublicHeaderAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export function PublicSiteHeader({
  active,
  onHome,
  onJobs,
  action,
  className = "",
}: {
  active?: PrimaryNavItem;
  onHome?: () => void;
  onJobs?: () => void;
  action?: PublicHeaderAction;
  className?: string;
}) {
  const classes = [
    "site-header",
    "public-site-header",
    action ? "has-transfer" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <header className={classes}>
      <Link
        className="wordmark ascii-wordmark"
        href="/"
        aria-label="gênio home"
        onClick={(event) => {
          if (!onHome) return;
          event.preventDefault();
          onHome();
        }}
      >
        <BrandWordmark />
      </Link>

      <PrimaryNav active={active} onCreate={onHome} onJobs={onJobs} />

      <div className="header-actions">
        {action && (
          <button className="transfer-button" type="button" onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </button>
        )}
        <SiteMenu action={action} />
      </div>
    </header>
  );
}
