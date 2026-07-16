"use client";

import { useEffect, useState } from "react";

const INTRO_SESSION_KEY = "9enio:brand-intro:v1";
const ASCII_WORDMARK = [
  "         /\\",
  "   ____             _",
  "  / __ \\___  ____  (_)___",
  " / /_/ / _ \\/ __ \\/ / __ \\",
  " \\__, /  __/ / / / / /_/ /",
  "/____/\\___/_/ /_/_/\\____/",
].join("\n");

type IntroPhase = "checking" | "visible" | "leaving" | "hidden";

function shouldSkipIntro(): boolean {
  if (window.location.pathname !== "/") return true;
  if (window.location.search || window.location.hash) return true;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  try {
    return window.sessionStorage.getItem(INTRO_SESSION_KEY) === "seen";
  } catch {
    return false;
  }
}

function rememberIntro(): void {
  try {
    window.sessionStorage.setItem(INTRO_SESSION_KEY, "seen");
  } catch {
    // The animation remains safely disposable when storage is unavailable.
  }
}

export function BrandIntro() {
  const [phase, setPhase] = useState<IntroPhase>("checking");

  useEffect(() => {
    let leaveTimer: number | undefined;
    let hideTimer: number | undefined;
    let safetyTimer: number | undefined;
    const startTimer = window.setTimeout(() => {
      if (shouldSkipIntro()) {
        setPhase("hidden");
        return;
      }
      rememberIntro();
      setPhase("visible");
      leaveTimer = window.setTimeout(() => setPhase("leaving"), 1_200);
      hideTimer = window.setTimeout(() => setPhase("hidden"), 1_420);
      safetyTimer = window.setTimeout(() => setPhase("hidden"), 2_000);
    }, 0);
    const skip = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPhase("hidden");
    };
    window.addEventListener("keydown", skip);

    return () => {
      window.clearTimeout(startTimer);
      if (leaveTimer) window.clearTimeout(leaveTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
      if (safetyTimer) window.clearTimeout(safetyTimer);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  if (phase === "checking" || phase === "hidden") return null;

  function dismiss(focusComposer: boolean) {
    rememberIntro();
    setPhase("hidden");
    if (focusComposer) {
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#playlist-request")?.focus());
    }
  }

  return (
    <section
      className="brand-intro"
      data-phase={phase}
      data-testid="brand-intro"
    >
      <div className="brand-intro-lockup">
        <pre className="brand-intro-ascii" aria-hidden="true">{ASCII_WORDMARK}</pre>
        <span className="sr-only">9ênio</span>
      </div>
      <button
        className="brand-intro-skip"
        type="button"
        onClick={(event) => dismiss(document.activeElement === event.currentTarget)}
      >
        SKIP INTRO
      </button>
    </section>
  );
}
