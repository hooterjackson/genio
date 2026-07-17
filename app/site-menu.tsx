"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function SiteMenu() {
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
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
    <div className={`site-menu${open ? " is-open" : ""}`} ref={rootRef}>
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
        <nav id="site-menu-panel" className="site-menu-panel" aria-label="Site menu">
          <Link href="/feedback" onClick={preserveSourcePage}>SUBMIT BUG OR IMPROVEMENT</Link>
          <Link href="/privacy" onClick={() => setOpen(false)}>PRIVACY</Link>
        </nav>
      )}
    </div>
  );
}
