import type {
  PlaylistBrief,
  SourceAdapter,
  SourceAdapterContainer,
  SourceAdapterContainerRef,
  SourceAdapterContext,
  SourceAdapterEntity,
  SourceAdapterEvidence,
  SourceAdapterResult,
} from "../shared/types.ts";
import { assertPublicHttpsUrl } from "./security.ts";
import { optionalSecret } from "./secrets.ts";
import { searchAppleCatalog } from "./apple.ts";
import { boundedResponseText } from "./bounded-response.ts";

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Adapter request aborted"));
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("Adapter request aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const MAX_ADAPTER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MUSICBRAINZ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENUMERATION_ITEM_LIMIT = 25;
const ENUMERATION_CREDIT_LIMIT = 100;
const ENUMERATION_CHUNK_BYTES = 48 * 1024;

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
  const text = await boundedResponseText(
    response,
    MAX_ADAPTER_RESPONSE_BYTES,
    "Structured adapter response exceeded the size limit",
  );
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

function stringValue(value: unknown, maximum = 240): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function boundedEnumerationChunk<T>(
  items: readonly T[],
  cursor: string | null,
  evidenceWeight: (item: T) => number = () => 1,
): { items: T[]; offset: number; nextCursor: string | null; complete: boolean } {
  const offset = safePositiveInteger(cursor, 0, 10_000);
  if (offset > items.length) throw new Error("Adapter enumeration cursor exceeds the container total");
  const chunk: T[] = [];
  let bytes = 0;
  let credits = 0;
  for (let index = offset; index < items.length && chunk.length < ENUMERATION_ITEM_LIMIT; index += 1) {
    const item = items[index]!;
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const itemCredits = Math.max(1, Math.min(Math.floor(evidenceWeight(item)), ENUMERATION_CREDIT_LIMIT));
    if (itemBytes > ENUMERATION_CHUNK_BYTES) throw new Error("A normalized adapter item exceeded the enumeration chunk limit");
    if (chunk.length > 0 && (bytes + itemBytes > ENUMERATION_CHUNK_BYTES || credits + itemCredits > ENUMERATION_CREDIT_LIMIT)) break;
    chunk.push(item);
    bytes += itemBytes;
    credits += itemCredits;
  }
  if (offset < items.length && chunk.length === 0) throw new Error("Adapter enumeration could not make bounded progress");
  const nextOffset = offset + chunk.length;
  return {
    items: chunk,
    offset,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    complete: nextOffset >= items.length,
  };
}

function musicBrainzArtistCredits(value: unknown): Array<{ name: string; joinPhrase: string | null }> {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((raw: unknown) => {
    const credit = objectValue(raw);
    const artist = objectValue(credit.artist);
    return {
      name: stringValue(credit.name) || stringValue(artist.name),
      joinPhrase: stringValue(credit.joinphrase, 40) || null,
    };
  }).filter((credit) => credit.name);
}

function discogsArtists(value: unknown): Array<{ name: string }> {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((raw: unknown) => ({
    name: stringValue(objectValue(raw).name),
  })).filter((artist) => artist.name);
}

function discogsTrackCredits(value: unknown): Array<{ name: string; role: string }> {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((raw: unknown) => {
    const credit = objectValue(raw);
    return { name: stringValue(credit.name, 160), role: stringValue(credit.role, 160) };
  }).filter((credit) => credit.name && credit.role);
}

function adapterRecord(result: SourceAdapterResult): string {
  return result.records[0]?.url ?? "";
}

function resultWithEvidence(
  adapter: SourceAdapter,
  result: Omit<SourceAdapterResult, "evidence">,
  context: SourceAdapterContext,
): SourceAdapterResult {
  const complete = { ...result, evidence: [] } as SourceAdapterResult;
  complete.evidence = adapter.normalizeEvidence(complete, context).slice(0, 250);
  return complete;
}

let musicBrainzQueue = Promise.resolve();
async function throttleMusicBrainz(signal?: AbortSignal): Promise<void> {
  const previous = musicBrainzQueue;
  let release!: () => void;
  musicBrainzQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { await wait(1_050, signal); } finally { release(); }
}

function musicBrainzHeaders(): Record<string, string> {
  const contact = process.env.MUSICBRAINZ_CONTACT ?? "operator-contact-not-configured.invalid";
  return { "User-Agent": `9enio/1.0 (${contact})`, Accept: "application/json" };
}

class MusicBrainzAdapter implements SourceAdapter {
  id = "musicbrainz" as const;
  supports(): number { return 0.9; }

  async discover(entity: SourceAdapterEntity, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (entity === "catalog") throw new Error("MusicBrainz does not support catalog discovery");
    const offset = safePositiveInteger(cursor, 0, 100_000);
    const url = new URL(`https://musicbrainz.org/ws/2/${entity}`);
    url.searchParams.set("query", query.slice(0, 300));
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", String(offset));
    await throttleMusicBrainz(signal);
    const response = await adapterFetch(url, "musicbrainz.org", { headers: musicBrainzHeaders() }, signal);
    if (!response.ok) throw new Error(`MusicBrainz failed (${response.status})`);
    const payload = await adapterJson(response);
    const key = `${entity}s`;
    const items = Array.isArray(payload[key]) ? payload[key].slice(0, 50) : [];
    const advertisedTotal = boundedProviderCount(payload.count, offset + items.length, 1_000_000);
    const boundedTotal = Math.min(advertisedTotal, 100_000);
    const next = offset + items.length;
    const hitPaginationLimit = advertisedTotal > 100_000 && next >= 100_000;
    const containers = entity === "release"
      ? items.map((raw: unknown): SourceAdapterContainer | null => {
        const item = objectValue(raw);
        const externalId = stringValue(item.id, 64);
        const title = stringValue(item.title);
        if (!MUSICBRAINZ_ID.test(externalId) || !title) return null;
        const media = Array.isArray(item.media) ? item.media : [];
        const trackCounts = media.map((medium: unknown) => boundedProviderCount(objectValue(medium)["track-count"], 0, 100_000));
        const advertisedTracks = trackCounts.length > 0 ? trackCounts.reduce((sum: number, count: number) => sum + count, 0) : null;
        return {
          containerType: "release",
          providerId: `musicbrainz:release:${externalId}`,
          title,
          advertisedTotal: advertisedTracks,
          metadata: { adapterId: this.id, entity: "release", externalId, country: stringValue(item.country, 8) || null, date: stringValue(item.date, 32) || null },
        };
      }).filter((item: SourceAdapterContainer | null): item is SourceAdapterContainer => item !== null)
      : [];
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `MusicBrainz ${entity} search`,
        sourceClass: "musicbrainz",
        provenanceRoot: "musicbrainz.org",
        note: `Structured ${entity} discovery for ${query.slice(0, 120)}; catalog metadata only`,
      }],
      items,
      containers,
      nextCursor: items.length > 0 && next < boundedTotal ? String(next) : null,
      complete: !hitPaginationLimit && (items.length === 0 || next >= boundedTotal),
      note: hitPaginationLimit ? `${items.length} results; stopped at the 100,000-result pagination safety limit` : `${items.length} of ${advertisedTotal} ${key}`,
      advertisedTotal,
    }, { action: "discover", entity, query, container: null, providerId: null });
  }

  async enumerate(container: SourceAdapterContainerRef, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (container.containerType !== "release" || container.metadata.adapterId !== this.id) throw new Error("MusicBrainz can enumerate only its own release containers");
    const externalId = stringValue(container.metadata.externalId, 64);
    if (!MUSICBRAINZ_ID.test(externalId)) throw new Error("MusicBrainz release identifier is invalid");
    const url = new URL(`https://musicbrainz.org/ws/2/release/${externalId}`);
    url.searchParams.set("inc", "recordings+artist-credits+media");
    url.searchParams.set("fmt", "json");
    await throttleMusicBrainz(signal);
    const response = await adapterFetch(url, "musicbrainz.org", { headers: musicBrainzHeaders() }, signal);
    if (!response.ok) throw new Error(`MusicBrainz release lookup failed (${response.status})`);
    const payload = await adapterJson(response);
    const allTracks = (Array.isArray(payload.media) ? payload.media : []).flatMap((medium: unknown) => {
      const mediumObject = objectValue(medium);
      return (Array.isArray(mediumObject.tracks) ? mediumObject.tracks : []).map((raw: unknown) => {
        const track = objectValue(raw);
        const recording = objectValue(track.recording);
        return {
          kind: "recording_metadata",
          providerId: stringValue(recording.id, 64) || null,
          position: stringValue(track.number, 32) || null,
          title: stringValue(recording.title) || stringValue(track.title),
          durationMs: boundedProviderCount(recording.length ?? track.length, 0, 24 * 60 * 60 * 1_000) || null,
          artistCredit: musicBrainzArtistCredits(recording["artist-credit"]),
        };
      });
    });
    const hitEnumerationLimit = allTracks.length > 10_000;
    const tracks = allTracks.slice(0, 10_000);
    const chunk = boundedEnumerationChunk(tracks, cursor);
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `MusicBrainz release: ${stringValue(payload.title) || container.title}`,
        sourceClass: "musicbrainz",
        provenanceRoot: "musicbrainz.org",
        note: "Paginated MusicBrainz release track enumeration; recording metadata only, not performer-credit proof",
      }],
      items: chunk.items,
      containers: [],
      nextCursor: chunk.nextCursor,
      complete: chunk.complete && !hitEnumerationLimit,
      note: hitEnumerationLimit && chunk.nextCursor === null
        ? `${chunk.items.length} recordings at offset ${chunk.offset}; stopped at the 10,000-track safety limit with ${allTracks.length} advertised`
        : `${chunk.items.length} recordings at offset ${chunk.offset} of ${allTracks.length} from release ${externalId}`,
      advertisedTotal: allTracks.length,
    }, { action: "enumerate", entity: "release", query: null, container, providerId: externalId });
  }

  async lookup(entity: SourceAdapterEntity, providerId: string, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (entity === "catalog" || !MUSICBRAINZ_ID.test(providerId)) throw new Error("MusicBrainz lookup identifier is invalid");
    const url = new URL(`https://musicbrainz.org/ws/2/${entity}/${providerId}`);
    url.searchParams.set("fmt", "json");
    await throttleMusicBrainz(signal);
    const response = await adapterFetch(url, "musicbrainz.org", { headers: musicBrainzHeaders() }, signal);
    if (!response.ok) throw new Error(`MusicBrainz lookup failed (${response.status})`);
    const payload = await adapterJson(response);
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `MusicBrainz ${entity} lookup`,
        sourceClass: "musicbrainz",
        provenanceRoot: "musicbrainz.org",
        note: "Structured entity metadata only",
      }],
      items: [payload],
      containers: [],
      nextCursor: null,
      complete: true,
      note: `Resolved MusicBrainz ${entity} ${providerId}`,
      advertisedTotal: 1,
    }, { action: "lookup", entity, query: null, container: null, providerId });
  }

  normalizeEvidence(result: SourceAdapterResult, context: SourceAdapterContext): SourceAdapterEvidence[] {
    const sourceUrl = adapterRecord(result);
    if (!sourceUrl) return [];
    return result.items.slice(0, 250).map((raw) => {
      const item = objectValue(raw);
      return {
        sourceUrl,
        evidenceKind: "metadata" as const,
        supportScope: context.action === "enumerate" ? "track" as const : "collection" as const,
        subject: null,
        relationship: "catalog metadata only",
        trackTitle: stringValue(item.title) || stringValue(item.name) || null,
        note: "MusicBrainz identifies an entity or recording but does not, by itself, prove the requested performer or editorial relationship.",
        eligibleForAutomaticVerification: false,
      };
    });
  }
}

function discogsProvider(container: SourceAdapterContainerRef): { type: "release" | "master"; id: number } {
  if (container.containerType !== "release" || container.metadata.adapterId !== "discogs") throw new Error("Discogs can enumerate only its own release containers");
  const type = container.metadata.externalType === "master" ? "master" : "release";
  const id = Number(container.metadata.externalId);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new Error("Discogs release identifier is invalid");
  return { type, id };
}

class DiscogsAdapter implements SourceAdapter {
  id = "discogs" as const;
  supports(): number { return optionalSecret("DISCOGS_TOKEN") ? 0.7 : 0; }

  private headers(): Record<string, string> {
    const token = optionalSecret("DISCOGS_TOKEN");
    if (!token) throw new Error("Discogs token not configured");
    return { Authorization: `Discogs token=${token}`, "User-Agent": "9enio/1.0", Accept: "application/json" };
  }

  async discover(entity: SourceAdapterEntity, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (entity === "catalog") throw new Error("Discogs does not support Apple catalog discovery");
    const page = safePositiveInteger(cursor, 1, 200);
    if (page < 1) throw new Error("Discogs page must be positive");
    const url = new URL("https://api.discogs.com/database/search");
    const parameter = entity === "release" ? "credit" : entity === "recording" ? "track" : "artist";
    url.searchParams.set(parameter, query.slice(0, 200));
    if (entity === "release") url.searchParams.set("type", "release");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await adapterFetch(url, "api.discogs.com", { headers: this.headers() }, signal);
    if (!response.ok) throw new Error(`Discogs failed (${response.status})`);
    const payload = await adapterJson(response);
    const advertisedPages = Math.max(page, boundedProviderCount(payload.pagination?.pages, page, 10_000));
    const pages = Math.min(advertisedPages, 200);
    const items = Array.isArray(payload.results) ? payload.results.slice(0, 50) : [];
    const hitPaginationLimit = advertisedPages > 200 && page >= 200;
    const containers = entity === "release"
      ? items.map((raw: unknown): SourceAdapterContainer | null => {
        const item = objectValue(raw);
        const externalType = item.type === "master" ? "master" : item.type === "release" ? "release" : null;
        const externalId = Number(item.id);
        const title = stringValue(item.title);
        if (!externalType || !Number.isSafeInteger(externalId) || externalId < 1 || !title) return null;
        return {
          containerType: "release",
          providerId: `discogs:${externalType}:${externalId}`,
          title,
          advertisedTotal: null,
          metadata: { adapterId: this.id, entity: "release", externalType, externalId },
        };
      }).filter((item: SourceAdapterContainer | null): item is SourceAdapterContainer => item !== null)
      : [];
    const advertisedTotal = boundedProviderCount(payload.pagination?.items, items.length, 1_000_000);
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: "Discogs database search",
        sourceClass: "discogs",
        provenanceRoot: "discogs.com",
        note: entity === "release"
          ? `Discogs performer-credit release discovery for ${query.slice(0, 120)}; search metadata only`
          : `Discogs ${entity} discovery for ${query.slice(0, 120)}; search metadata only`,
      }],
      items,
      containers,
      nextCursor: page < pages ? String(page + 1) : null,
      complete: !hitPaginationLimit && page >= pages,
      note: hitPaginationLimit ? `${items.length} results; stopped at the 200-page pagination safety limit` : `${items.length} results on page ${page} of ${advertisedPages}`,
      advertisedTotal,
    }, { action: "discover", entity, query, container: null, providerId: null });
  }

  async enumerate(container: SourceAdapterContainerRef, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    const provider = discogsProvider(container);
    const collection = provider.type === "master" ? "masters" : "releases";
    const url = new URL(`https://api.discogs.com/${collection}/${provider.id}`);
    const response = await adapterFetch(url, "api.discogs.com", { headers: this.headers() }, signal);
    if (!response.ok) throw new Error(`Discogs release lookup failed (${response.status})`);
    const payload = await adapterJson(response);
    const allTracks: Array<{
      kind: string;
      position: string | null;
      title: string;
      duration: string | null;
      artists: Array<{ name: string }>;
      extraartists: Array<{ name: string; role: string }>;
    }> = (Array.isArray(payload.tracklist) ? payload.tracklist : [])
      .filter((raw: unknown) => objectValue(raw).type_ === "track")
      .map((raw: unknown) => {
        const track = objectValue(raw);
        return {
          kind: "track_metadata",
          position: stringValue(track.position, 40) || null,
          title: stringValue(track.title),
          duration: stringValue(track.duration, 24) || null,
          artists: discogsArtists(track.artists),
          extraartists: discogsTrackCredits(track.extraartists),
        };
      });
    const hitEnumerationLimit = allTracks.length > 10_000;
    const tracks = allTracks.slice(0, 10_000);
    const chunk = boundedEnumerationChunk(tracks, cursor, (track) => track.extraartists.length);
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `Discogs ${provider.type}: ${stringValue(payload.title) || container.title}`,
        sourceClass: "discogs",
        provenanceRoot: "discogs.com",
        note: "Paginated Discogs release track enumeration; explicit track credits are normalized but remain inferred pending corroboration",
      }],
      items: chunk.items,
      containers: [],
      nextCursor: chunk.nextCursor,
      complete: chunk.complete && !hitEnumerationLimit,
      note: hitEnumerationLimit && chunk.nextCursor === null
        ? `${chunk.items.length} tracks at offset ${chunk.offset}; stopped at the 10,000-track safety limit with ${allTracks.length} advertised`
        : `${chunk.items.length} tracks at offset ${chunk.offset} of ${allTracks.length} from Discogs ${provider.type} ${provider.id}`,
      advertisedTotal: allTracks.length,
    }, { action: "enumerate", entity: "release", query: null, container, providerId: String(provider.id) });
  }

  async lookup(entity: SourceAdapterEntity, providerId: string, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (entity !== "artist" && entity !== "release") throw new Error("Discogs supports direct artist and release lookups only");
    const id = Number(providerId);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new Error("Discogs lookup identifier is invalid");
    const collection = entity === "artist" ? "artists" : "releases";
    const url = new URL(`https://api.discogs.com/${collection}/${id}`);
    const response = await adapterFetch(url, "api.discogs.com", { headers: this.headers() }, signal);
    if (!response.ok) throw new Error(`Discogs lookup failed (${response.status})`);
    const payload = await adapterJson(response);
    return resultWithEvidence(this, {
      records: [{
        url: assertPublicHttpsUrl(url.toString()).toString(),
        title: `Discogs ${entity} lookup`,
        sourceClass: "discogs",
        provenanceRoot: "discogs.com",
        note: "Structured entity metadata; not relationship proof",
      }],
      items: [payload],
      containers: [],
      nextCursor: null,
      complete: true,
      note: `Resolved Discogs ${entity} ${id}`,
      advertisedTotal: 1,
    }, { action: "lookup", entity, query: null, container: null, providerId: String(id) });
  }

  normalizeEvidence(result: SourceAdapterResult, context: SourceAdapterContext): SourceAdapterEvidence[] {
    const sourceUrl = adapterRecord(result);
    if (!sourceUrl) return [];
    if (context.action !== "enumerate") {
      return result.items.slice(0, 250).map((raw) => {
        const item = objectValue(raw);
        return {
          sourceUrl,
          evidenceKind: "metadata" as const,
          supportScope: "collection" as const,
          subject: null,
          relationship: "database metadata only",
          trackTitle: stringValue(item.title) || null,
          note: "A Discogs search or entity result is discovery metadata, not proof of the requested relationship.",
          eligibleForAutomaticVerification: false,
        };
      });
    }
    const evidence: SourceAdapterEvidence[] = [];
    for (const raw of result.items.slice(0, 10_000)) {
      const track = objectValue(raw);
      const trackTitle = stringValue(track.title) || null;
      for (const creditRaw of Array.isArray(track.extraartists) ? track.extraartists.slice(0, 100) : []) {
        const credit = objectValue(creditRaw);
        const subject = stringValue(credit.name);
        const role = stringValue(credit.role);
        if (!subject || !role) continue;
        evidence.push({
          sourceUrl,
          evidenceKind: "track_credit",
          supportScope: "track",
          subject,
          relationship: role,
          trackTitle,
          note: `Discogs explicitly assigns ${role} to ${subject} on this track; retain as inferred until independently corroborated.`,
          eligibleForAutomaticVerification: false,
        });
        if (evidence.length >= 250) return evidence;
      }
    }
    return evidence;
  }
}

class AppleAdapter implements SourceAdapter {
  id = "apple" as const;
  supports(): number { return 0.8; }

  async discover(entity: SourceAdapterEntity, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult> {
    if (entity !== "catalog" && entity !== "recording") throw new Error("Apple adapter supports catalog song discovery only");
    if (cursor !== null) throw new Error("Apple catalog search is not cursor-paginated by this adapter");
    const storefront = (process.env.APPLE_STOREFRONT ?? "br").toLowerCase();
    const items = await searchAppleCatalog(storefront, query, signal);
    const url = `https://music.apple.com/${storefront}/search?term=${encodeURIComponent(query)}`;
    return resultWithEvidence(this, {
      records: [{
        url,
        title: "Apple Music catalog search",
        sourceClass: "apple",
        provenanceRoot: "music.apple.com",
        note: "Catalog metadata only; not personnel or influence evidence.",
      }],
      items,
      containers: [],
      nextCursor: null,
      complete: true,
      note: `${items.length} catalog results`,
      advertisedTotal: items.length,
    }, { action: "discover", entity, query, container: null, providerId: null });
  }

  async enumerate(): Promise<SourceAdapterResult> {
    throw new Error("Apple catalog results are not research containers");
  }

  async lookup(): Promise<SourceAdapterResult> {
    throw new Error("Apple catalog lookup is performed by the deterministic matching gateway");
  }

  normalizeEvidence(result: SourceAdapterResult): SourceAdapterEvidence[] {
    const sourceUrl = adapterRecord(result);
    if (!sourceUrl) return [];
    return result.items.slice(0, 250).map((raw) => {
      const item = objectValue(raw);
      return {
        sourceUrl,
        evidenceKind: "metadata" as const,
        supportScope: "track" as const,
        subject: stringValue(item.artistName) || null,
        relationship: "catalog availability metadata only",
        trackTitle: stringValue(item.name) || null,
        note: "Apple Music metadata supports catalog matching and availability, not performer credits or cultural influence.",
        eligibleForAutomaticVerification: false,
      };
    });
  }
}

export function discogsAdapterEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV !== "production" && environment.ENABLE_DISCOGS_ADAPTER === "true";
}

export function createAdapterRegistry(_legacyRepository?: unknown): Map<string, SourceAdapter> {
  void _legacyRepository;
  const adapters: SourceAdapter[] = [new MusicBrainzAdapter(), new AppleAdapter()];
  // Discogs is deliberately excluded from production while its public-service
  // terms and operating limits are unresolved. A token alone never enables it.
  if (discogsAdapterEnabled()) adapters.splice(1, 0, new DiscogsAdapter());
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

export function bestAdapters(brief: PlaylistBrief, adapters: Map<string, SourceAdapter>): string[] {
  return [...adapters.values()]
    .filter((adapter) => adapter.supports(brief) > 0)
    .sort((a, b) => b.supports(brief) - a.supports(brief))
    .map((adapter) => adapter.id);
}
