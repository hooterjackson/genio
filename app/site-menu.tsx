"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function SiteMenu({
  action,
}: {
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
} = {}) {
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreTriggerFocusRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setHydrated(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (open && root && !root.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      restoreTriggerFocusRef.current = true;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  useEffect(() => {
    if (open || !restoreTriggerFocusRef.current) return;
    restoreTriggerFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function preserveSourcePage() {
    try {
      window.sessionStorage.setItem("9enio.feedback.sourcePath", window.location.pathname);
    } catch {
      // Feedback still works when browser storage is unavailable.
    }
    setOpen(false);
  }

  return (
    <div
      className={`site-menu${open ? " is-open" : ""}`}
      ref={rootRef}
      onBlur={() => {
        window.requestAnimationFrame(() => {
          const root = rootRef.current;
          if (root && !root.contains(document.activeElement)) setOpen(false);
        });
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="site-menu-trigger"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="site-menu-panel"
        disabled={!hydrated}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>
      {open && (
        <nav ref={panelRef} id="site-menu-panel" className="site-menu-panel" aria-label="Site menu">
          {action && (
            <button
              type="button"
              className="site-menu-mobile-action"
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
          <Link href="/feedback" onClick={preserveSourcePage}>SUBMIT BUG OR IMPROVEMENT</Link>
          <Link href="/privacy" onClick={() => setOpen(false)}>PRIVACY</Link>
        </nav>
      )}
    </div>
  );
}
