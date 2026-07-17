"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export function SiteMenu() {
  const rootRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root?.open && !root.contains(event.target as Node)) root.open = false;
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !rootRef.current?.open) return;
      rootRef.current.open = false;
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, []);

  function preserveSourcePage() {
    try {
      window.sessionStorage.setItem("9enio.feedback.sourcePath", window.location.pathname);
    } catch {
      // Feedback still works when browser storage is unavailable.
    }
    if (rootRef.current) rootRef.current.open = false;
  }

  return (
    <details className="site-menu" ref={rootRef} suppressHydrationWarning>
      <summary
        ref={triggerRef}
        className="site-menu-trigger"
        role="button"
        aria-label="Open menu"
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </summary>
      <nav className="site-menu-panel" aria-label="Site menu">
        <Link href="/feedback" onClick={preserveSourcePage}>SUBMIT BUG OR IMPROVEMENT</Link>
        <Link href="/privacy" onClick={() => { if (rootRef.current) rootRef.current.open = false; }}>PRIVACY</Link>
      </nav>
    </details>
  );
}
