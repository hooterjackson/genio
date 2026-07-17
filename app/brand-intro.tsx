"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GENIO_ASCII_WORDMARK } from "./brand-wordmark";

const INTRO_SESSION_KEY = "9enio:brand-intro:v2";
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
  const skipRef = useRef<HTMLButtonElement>(null);
  const restoreComposerFocusRef = useRef(false);

  const requestComposerFocus = useCallback(() => {
    restoreComposerFocusRef.current = true;
  }, []);

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
        if (nextCharacterCount < GENIO_ASCII_WORDMARK.length) return;

        if (intervalRef.current !== undefined) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = undefined;
        }
        timeoutRefs.current.push(
          window.setTimeout(() => setPhase("leaving"), COMPLETION_HOLD_MS),
          window.setTimeout(() => {
            requestComposerFocus();
            setPhase("hidden");
          }, COMPLETION_HOLD_MS + FADE_DURATION_MS),
        );
      }, CHARACTER_INTERVAL_MS);
    }, 0);
    timeoutRefs.current.push(startTimer);
    const skip = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearAnimation();
        requestComposerFocus();
        setPhase("hidden");
      }
    };
    window.addEventListener("keydown", skip);

    return () => {
      clearAnimation();
      window.removeEventListener("keydown", skip);
    };
  }, [clearAnimation, requestComposerFocus]);

  useEffect(() => {
    if (phase !== "hidden" || !restoreComposerFocusRef.current) return;
    restoreComposerFocusRef.current = false;
    // The hidden phase has committed, so the focused intro control is no
    // longer in the document and focus can be restored without racing React.
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      document.querySelector<HTMLTextAreaElement>("#playlist-request")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase !== "visible") return;
    const frame = window.requestAnimationFrame(() => skipRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  if (phase === "checking" || phase === "hidden") return null;

  function dismiss(shouldFocusComposer: boolean) {
    clearAnimation();
    rememberIntro();
    if (shouldFocusComposer) requestComposerFocus();
    setPhase("hidden");
  }

  return (
    <section
      className="brand-intro"
      data-phase={phase}
      data-testid="brand-intro"
      role="dialog"
      aria-modal="true"
      aria-label="gênio introduction"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        skipRef.current?.focus();
      }}
    >
      <div
        className="brand-intro-lockup"
        data-character-count={visibleCharacterCount}
        data-character-total={GENIO_ASCII_WORDMARK.length}
      >
        <pre className="brand-intro-ascii brand-intro-measure" aria-hidden="true">{GENIO_ASCII_WORDMARK}</pre>
        <pre className="brand-intro-ascii brand-intro-typed" aria-hidden="true">{GENIO_ASCII_WORDMARK.slice(0, visibleCharacterCount)}</pre>
        <span className="sr-only">gênio</span>
      </div>
      <button
        ref={skipRef}
        className="brand-intro-skip"
        type="button"
        onClick={(event) => dismiss(document.activeElement === event.currentTarget)}
      >
        SKIP INTRO
      </button>
    </section>
  );
}
