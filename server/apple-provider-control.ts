import { AppleApiError } from "./apple.ts";
import type { CatalogDiscoveryProvider } from "./catalog-discovery-v2.ts";

// The original AppleApiError must keep flowing to discovery so status,
// Retry-After, and retriable classification remain intact. This side channel
// lets the outer, run-scoped cache wrapper persist exactly the request that
// transitioned the shared provider circuit from closed to open.
const providerCircuitOpeningErrors = new WeakSet<object>();
// Retain an observation marker after the telemetry/cache layer consumes the
// one-shot opening event. Discovery still needs to distinguish a provider
// circuit from an ordinary transient request failure when it chooses a typed
// terminal outcome. WeakSet keeps this metadata bounded by the error object's
// lifetime.
const providerCircuitObservedErrors = new WeakSet<object>();

export function isAppleProviderCircuitOpening(error: unknown): boolean {
  return Boolean(error) && (typeof error === "object" || typeof error === "function")
    && providerCircuitOpeningErrors.has(error as object);
}

export function consumeAppleProviderCircuitOpening(error: unknown): boolean {
  if (!isAppleProviderCircuitOpening(error)) return false;
  providerCircuitOpeningErrors.delete(error as object);
  return true;
}

export function wasAppleProviderCircuitOpening(error: unknown): boolean {
  return Boolean(error) && (typeof error === "object" || typeof error === "function")
    && providerCircuitObservedErrors.has(error as object);
}

export interface AppleProviderControlSnapshot {
  currentConcurrency: number;
  activeRequests: number;
  consecutiveTransientFailures: number;
  blockedUntilMs: number;
}

export interface AppleProviderControlOptions {
  initialConcurrency?: number;
  minimumConcurrency?: number;
  maximumConcurrency?: number;
  transientFailureThreshold?: number;
  recoverySuccesses?: number;
  circuitCooldownMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Apple request aborted"));
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Apple request aborted"));
  }, { once: true });
});

function boundedConcurrency(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(32, Math.floor(value!)));
}

/**
 * Process-shared admission gate for all V2 Apple discovery reads. AppleMusicClient
 * owns the bounded three-attempt HTTP retry; this gate owns cross-run pressure,
 * Retry-After cooldown, and a circuit after repeated exhausted failures.
 */
export class AppleProviderControl {
  private readonly minimumConcurrency: number;
  private readonly maximumConcurrency: number;
  private readonly transientFailureThreshold: number;
  private readonly recoverySuccesses: number;
  private readonly circuitCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private currentConcurrency: number;
  private activeRequests = 0;
  private consecutiveTransientFailures = 0;
  private successStreak = 0;
  private blockedUntilMs = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: AppleProviderControlOptions = {}) {
    this.minimumConcurrency = boundedConcurrency(options.minimumConcurrency, 2);
    this.maximumConcurrency = Math.max(
      this.minimumConcurrency,
      boundedConcurrency(options.maximumConcurrency, 8),
    );
    this.currentConcurrency = Math.min(
      this.maximumConcurrency,
      Math.max(this.minimumConcurrency, boundedConcurrency(options.initialConcurrency, 6)),
    );
    this.transientFailureThreshold = Math.max(2, Math.floor(options.transientFailureThreshold ?? 3));
    this.recoverySuccesses = Math.max(2, Math.floor(options.recoverySuccesses ?? 8));
    this.circuitCooldownMs = Math.max(1_000, Math.floor(options.circuitCooldownMs ?? 10_000));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  snapshot(): AppleProviderControlSnapshot {
    return {
      currentConcurrency: this.currentConcurrency,
      activeRequests: this.activeRequests,
      consecutiveTransientFailures: this.consecutiveTransientFailures,
      blockedUntilMs: this.blockedUntilMs,
    };
  }

  private wakeWaiters(): void {
    while (this.waiters.length > 0 && this.activeRequests < this.currentConcurrency) {
      this.waiters.shift()?.();
    }
  }

  private async admit(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const delay = this.blockedUntilMs - this.now();
      if (delay > 0) {
        await this.sleep(delay, signal);
        continue;
      }
      if (this.activeRequests < this.currentConcurrency) {
        this.activeRequests += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error("Apple request aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
  }

  private observeSuccess(): void {
    this.consecutiveTransientFailures = 0;
    this.successStreak += 1;
    if (this.successStreak >= this.recoverySuccesses && this.currentConcurrency < this.maximumConcurrency) {
      this.currentConcurrency += 1;
      this.successStreak = 0;
      this.wakeWaiters();
    }
  }

  private observeFailure(error: unknown): boolean {
    const appleError = error instanceof AppleApiError ? error : null;
    if (!appleError?.retriable) {
      this.consecutiveTransientFailures = 0;
      this.successStreak = 0;
      return false;
    }
    this.successStreak = 0;
    this.consecutiveTransientFailures += 1;
    if (appleError.status === 429) {
      this.currentConcurrency = Math.max(this.minimumConcurrency, Math.floor(this.currentConcurrency / 2));
      this.blockedUntilMs = Math.max(
        this.blockedUntilMs,
        this.now() + Math.max(1_000, appleError.retryAfterMs ?? this.circuitCooldownMs),
      );
      return false;
    }
    this.currentConcurrency = Math.max(this.minimumConcurrency, this.currentConcurrency - 1);
    if (this.consecutiveTransientFailures >= this.transientFailureThreshold) {
      const observedAt = this.now();
      const wasOpen = this.blockedUntilMs > observedAt;
      this.blockedUntilMs = Math.max(this.blockedUntilMs, observedAt + this.circuitCooldownMs);
      return !wasOpen;
    }
    return false;
  }

  async execute<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.admit(signal);
    try {
      const result = await operation();
      this.observeSuccess();
      return result;
    } catch (error) {
      if (this.observeFailure(error)
        && error
        && (typeof error === "object" || typeof error === "function")) {
        providerCircuitOpeningErrors.add(error as object);
        providerCircuitObservedErrors.add(error as object);
      }
      throw error;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.wakeWaiters();
    }
  }
}

export const sharedAppleProviderControl = new AppleProviderControl();

export function createControlledCatalogDiscoveryProvider(
  provider: CatalogDiscoveryProvider,
  control: AppleProviderControl = sharedAppleProviderControl,
): CatalogDiscoveryProvider {
  return {
    search: (storefront, query, types, limit, signal, cursor) => control.execute(
      () => provider.search(storefront, query, types, limit, signal, cursor), signal,
    ),
    playlistTracks: (storefront, playlistId, cursor, signal) => control.execute(
      () => provider.playlistTracks(storefront, playlistId, cursor, signal), signal,
    ),
    albumTracks: (storefront, albumId, cursor, signal) => control.execute(
      () => provider.albumTracks(storefront, albumId, cursor, signal), signal,
    ),
    artistTopSongs: (storefront, artistId, cursor, signal) => control.execute(
      () => provider.artistTopSongs(storefront, artistId, cursor, signal), signal,
    ),
    artistAlbums: (storefront, artistId, view, cursor, signal) => control.execute(
      () => provider.artistAlbums(storefront, artistId, view, cursor, signal), signal,
    ),
    similarArtists: (storefront, artistId, cursor, signal) => control.execute(
      () => provider.similarArtists(storefront, artistId, cursor, signal), signal,
    ),
  };
}
