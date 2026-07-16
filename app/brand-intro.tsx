"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const INTRO_SESSION_KEY = "9enio:brand-intro:v1";
const ASCII_WORDMARK = [
  "         /\\",
  "   ____             _",
  "  / __ \\___  ____  (_)___",
  " / /_/ / _ \\/ __ \\/ / __ \\",
  " \\__, /  __/ / / / / /_/ /",
  "/____/\\___/_/ /_/_/\\____/",
].join("\n");
const CHARACTER_INTERVAL_MS = 10;
const COMPLETION_HOLD_MS = 500;
const FADE_DURATION_MS = 180;

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
  const [visibleCharacterCount, setVisibleCharacterCount] = useState(0);
  const intervalRef = useRef<number | undefined>(undefined);
  const timeoutRefs = useRef<number[]>([]);

  const clearAnimation = useCallback(() => {
    if (intervalRef.current !== undefined) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
    for (const timeout of timeoutRefs.current) window.clearTimeout(timeout);
    timeoutRefs.current = [];
  }, []);

  useEffect(() => {
    const startTimer = window.setTimeout(() => {
      if (shouldSkipIntro()) {
        setPhase("hidden");
        return;
      }
      rememberIntro();
      setVisibleCharacterCount(0);
      setPhase("visible");
      let nextCharacterCount = 0;
      intervalRef.current = window.setInterval(() => {
        nextCharacterCount += 1;
        setVisibleCharacterCount(nextCharacterCount);
        if (nextCharacterCount < ASCII_WORDMARK.length) return;

        if (intervalRef.current !== undefined) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = undefined;
        }
        timeoutRefs.current.push(
          window.setTimeout(() => setPhase("leaving"), COMPLETION_HOLD_MS),
          window.setTimeout(() => setPhase("hidden"), COMPLETION_HOLD_MS + FADE_DURATION_MS),
        );
      }, CHARACTER_INTERVAL_MS);
    }, 0);
    timeoutRefs.current.push(startTimer);
    const skip = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearAnimation();
        setPhase("hidden");
      }
    };
    window.addEventListener("keydown", skip);

    return () => {
      clearAnimation();
      window.removeEventListener("keydown", skip);
    };
  }, [clearAnimation]);

  if (phase === "checking" || phase === "hidden") return null;

  function dismiss(focusComposer: boolean) {
    clearAnimation();
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
      <div
        className="brand-intro-lockup"
        data-character-count={visibleCharacterCount}
        data-character-total={ASCII_WORDMARK.length}
      >
        <pre className="brand-intro-ascii brand-intro-measure" aria-hidden="true">{ASCII_WORDMARK}</pre>
        <pre className="brand-intro-ascii brand-intro-typed" aria-hidden="true">{ASCII_WORDMARK.slice(0, visibleCharacterCount)}</pre>
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
