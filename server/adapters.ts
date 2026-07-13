import type { PlaylistBrief, SourceAdapter, SourceAdapterResult } from "../shared/types.ts";
import { assertPublicHttpsUrl } from "./security.ts";
import { optionalSecret } from "./secrets.ts";
import { searchAppleCatalog } from "./apple.ts";

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Adapter request aborted"));
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Adapter request aborted"));
  }, { once: true });
});

const MAX_ADAPTER_RESPONSE_BYTES = 4 * 1024 * 1024;

function assertFixedHost(url: URL, expectedHost: string): void {
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.username || url.password) {
    throw new Error("Structured adapter attempted to reach a non-allowlisted host");
  }
}

async function adapterFetch(url: URL, expectedHost: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  assertFixedHost(url, expectedHost);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      lastStatus = response.status;
      if (response.status >= 300 && response.status < 400) throw new Error("Structured adapter redirects are not allowed");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_ADAPTER_RESPONSE_BYTES) throw new Error("Structured adapter response exceeded the size limit");
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 15_000) : 500 * 2 ** attempt, signal);
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes("redirect") || error.message.includes("size limit"))) throw error;
      if (attempt === 2) throw new Error("Structured source could not be reached after three attempts");
      if (signal?.aborted) throw signal.reason ?? error;
      await wait(500 * 2 ** attempt, signal);
    }
  }
  throw new Error(`Structured source failed after three attempts (${lastStatus || "network"})`);
}

async function adapterJson(response: Response): Promise<any> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_ADAPTER_RESPONSE_BYTES) throw new Error("Structured adapter response exceeded the size limit");
  try { return JSON.parse(text); } catch { throw new Error("Structured adapter returned malformed JSON"); }
}

function safePositiveInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error("Adapter pagination cursor is invalid");
  return parsed;
}

function boundedProviderCount(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

let musicBrainzQueue = Promise.resolve();
async function throttleMusicBrainz(signal?: AbortSignal): Promise<void> {
  const previous = musicBrainzQueue;
  let release!: () => void;
  musicBrainzQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { await wait(1_050, signal); } finally { release(); }
}

class MusicBrainzAdapter implements SourceAdapter {
  id = "musicbrainz" as const;
  supports(): number { return 0.9; }

  async query(operation: string, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    const offset = safePositiveInteger(cursor, 0, 100_000);
    const entity = operation === "recordings" ? "recording" : operation === "releases" ? "release" : "artist";
    const url = new URL(`https://musicbrainz.org/ws/2/${entity}`);
    url.searchParams.set("query", query.slice(0, 300));
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", String(offset));
    await throttleMusicBrainz(signal);
    const contact = process.env.MUSICBRAINZ_CONTACT ?? "operator-contact-not-configured.invalid";
    const response = await adapterFetch(url, "musicbrainz.org", { headers: { "User-Agent": `Needle/1.0 (${contact})`, Accept: "application/json" } }, signal);
    if (!response.ok) throw new Error(`MusicBrainz failed (${response.status})`);
    const payload = await adapterJson(response);
    const key = entity === "artist" ? "artists" : entity === "release" ? "releases" : "recordings";
    const items = Array.isArray(payload[key]) ? payload[key].slice(0, 50) : [];
    const advertisedTotal = boundedProviderCount(payload.count, offset + items.length, 1_000_000);
    const count = Math.min(advertisedTotal, 100_000);
    const next = offset + items.length;
    const hitPaginationLimit = advertisedTotal > 100_000 && next >= 100_000;
    return {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `MusicBrainz ${entity} search`,
        sourceClass: "musicbrainz",
        provenanceRoot: "musicbrainz.org",
        note: `Structured ${entity} search for ${query.slice(0, 120)}`,
      }],
      items,
      nextCursor: items.length > 0 && next < count ? String(next) : null,
      complete: !hitPaginationLimit && (items.length === 0 || next >= count),
      note: hitPaginationLimit ? `${items.length} results; stopped at the 100,000-result pagination safety limit` : `${items.length} of ${advertisedTotal} ${key}`,
      advertisedTotal,
    } as SourceAdapterResult & { advertisedTotal: number };
  }
}

class DiscogsAdapter implements SourceAdapter {
  id = "discogs" as const;
  supports(): number { return optionalSecret("DISCOGS_TOKEN") ? 0.7 : 0; }

  async query(operation: string, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    const token = optionalSecret("DISCOGS_TOKEN");
    if (!token) return { records: [], items: [], nextCursor: null, complete: false, note: "Discogs token not configured" };
    const page = safePositiveInteger(cursor, 1, 200);
    if (page < 1) throw new Error("Discogs page must be positive");
    const url = new URL("https://api.discogs.com/database/search");
    url.searchParams.set(operation === "releases" ? "release_title" : "artist", query.slice(0, 200));
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await adapterFetch(url, "api.discogs.com", {
      headers: { Authorization: `Discogs token=${token}`, "User-Agent": "Needle/1.0", Accept: "application/json" },
    }, signal);
    if (!response.ok) throw new Error(`Discogs failed (${response.status})`);
    const payload = await adapterJson(response);
    const advertisedPages = Math.max(page, boundedProviderCount(payload.pagination?.pages, page, 10_000));
    const pages = Math.min(advertisedPages, 200);
    const items = Array.isArray(payload.results) ? payload.results.slice(0, 50) : [];
    const hitPaginationLimit = advertisedPages > 200 && page >= 200;
    return {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: "Discogs database search",
        sourceClass: "discogs",
        provenanceRoot: "discogs.com",
        note: `Discogs ${operation} search for ${query.slice(0, 120)}`,
      }],
      items,
      nextCursor: page < pages ? String(page + 1) : null,
      complete: !hitPaginationLimit && page >= pages,
      note: hitPaginationLimit ? `${items.length} results; stopped at the 200-page pagination safety limit` : `${items.length} results on page ${page} of ${advertisedPages}`,
      advertisedTotal: boundedProviderCount(payload.pagination?.items, items.length, 1_000_000),
    } as SourceAdapterResult & { advertisedTotal: number };
  }
}

class AppleAdapter implements SourceAdapter {
  id = "apple" as const;
  supports(): number { return 0.8; }

  async query(_operation: string, query: string, _cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    const storefront = (process.env.APPLE_STOREFRONT ?? "br").toLowerCase();
    const items = await searchAppleCatalog(storefront, query, signal);
    const url = `https://music.apple.com/${storefront}/search?term=${encodeURIComponent(query)}`;
    return {
      records: [{
        url,
        title: "Apple Music catalog search",
        sourceClass: "apple",
        provenanceRoot: "music.apple.com",
        note: "Catalog metadata only; not personnel or influence evidence.",
      }],
      items,
      nextCursor: null,
      complete: true,
      note: `${items.length} catalog results`,
      advertisedTotal: items.length,
    } as SourceAdapterResult & { advertisedTotal: number };
  }
}

export function createAdapterRegistry(_legacyRepository?: unknown): Map<string, SourceAdapter> {
  void _legacyRepository;
  const adapters: SourceAdapter[] = [new MusicBrainzAdapter(), new DiscogsAdapter(), new AppleAdapter()];
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

export function bestAdapters(brief: PlaylistBrief, adapters: Map<string, SourceAdapter>): string[] {
  return [...adapters.values()]
    .filter((adapter) => adapter.supports(brief) > 0)
    .sort((a, b) => b.supports(brief) - a.supports(brief))
    .map((adapter) => adapter.id);
}
