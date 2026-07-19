import { createHash, createPrivateKey, sign } from "node:crypto";
import type { CatalogSong } from "../shared/types.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { requirePrivateKey, requireSecret } from "./secrets.ts";

const APPLE_API = "https://api.music.apple.com";
const TOKEN_PURPOSE = "apple-music-user-token";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type AppleCatalogSearchType = "songs" | "artists" | "albums" | "playlists";

export interface AppleCatalogArtist {
  id: string;
  name: string;
  genreNames: string[];
  url?: string;
}

export interface AppleCatalogAlbum {
  id: string;
  name: string;
  artistName: string;
  genreNames: string[];
  releaseDate?: string;
  trackCount?: number;
  isSingle?: boolean;
  isCompilation?: boolean;
  recordLabel?: string;
  url?: string;
}

export interface AppleCatalogPlaylist {
  id: string;
  name: string;
  curatorName: string;
  description: string;
  playlistType?: string;
  url?: string;
}

export interface AppleCatalogSearchResult {
  songs: CatalogSong[];
  artists: AppleCatalogArtist[];
  albums: AppleCatalogAlbum[];
  playlists: AppleCatalogPlaylist[];
  /**
   * Apple paginates each search resource collection independently. Keeping
   * those continuations separate prevents a song cursor from being reused as
   * an artist, album, or playlist cursor.
   */
  next?: Partial<Record<AppleCatalogSearchType, string>>;
}

export interface AppleCatalogPage<T> {
  items: T[];
  next: string | null;
}

export interface AppleAuthorizationRecord {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  storefront: string;
  status: string;
  lastValidatedAt?: Date | null;
  lastError?: string | null;
}

export interface AppleAuthorizationStore {
  getAppleAuthorization(): Promise<AppleAuthorizationRecord | null>;
  saveAppleAuthorization(record: AppleAuthorizationRecord): Promise<void>;
  updateAppleAuthorizationStatus(status: string, lastError?: string | null): Promise<void>;
}

type AppleAuthorizationIdentity = Pick<AppleAuthorizationRecord, "ciphertext" | "keyVersion">;

export function appleAuthorizationGeneration(record: AppleAuthorizationIdentity): string {
  return createHash("sha256")
    .update(`${record.keyVersion}:${record.ciphertext}`)
    .digest("hex")
    .slice(0, 20);
}

export function appleAuthorizationJobDedupeKey(record: AppleAuthorizationIdentity): string {
  return `apple-authorization:${appleAuthorizationGeneration(record)}`;
}

export class AppleApiError extends Error {
  readonly name: string = "AppleApiError";

  constructor(
    message: string,
    readonly status: number | null,
    readonly retriable: boolean,
    readonly uncertainMutation = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export class AppleAuthorizationRequiredError extends AppleApiError {
  readonly name = "AppleAuthorizationRequiredError";

  constructor(status: 401 | 403) {
    super("The owner must reauthorize Apple Music before publication can continue", status, false, false);
  }
}

export class ApplePlaylistDivergedError extends Error {
  readonly name = "ApplePlaylistDivergedError";

  constructor(readonly playlistId: string, readonly existingCount: number) {
    super(`Apple playlist ${playlistId} no longer matches the approved manifest prefix`);
  }
}

export class AppleShareLinkUnavailableError extends Error {
  readonly name = "AppleShareLinkUnavailableError";

  constructor(readonly playlistId: string) {
    super(`Apple did not expose a stable share link for playlist ${playlistId}`);
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function encryptMusicUserToken(token: string): string {
  return encryptSecret(token.trim(), TOKEN_PURPOSE);
}

export function decryptMusicUserToken(encrypted: string): string {
  return decryptSecret(encrypted, TOKEN_PURPOSE);
}

function encryptedTokenColumns(token: string): Pick<AppleAuthorizationRecord, "ciphertext" | "iv" | "authTag" | "keyVersion"> {
  const envelope = JSON.parse(encryptMusicUserToken(token)) as { ciphertext: string; iv: string; tag: string; kid: string };
  return { ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.tag, keyVersion: envelope.kid };
}

function tokenEnvelope(record: AppleAuthorizationRecord): string {
  return JSON.stringify({ v: 1, alg: "A256GCM", kid: record.keyVersion, iv: record.iv, ciphertext: record.ciphertext, tag: record.authTag });
}

export async function saveOwnerAppleAuthorization(
  store: AppleAuthorizationStore,
  token: string,
  storefront: string,
): Promise<void> {
  if (!token.trim()) throw new Error("Apple Music user token is required");
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  await store.saveAppleAuthorization({
    ...encryptedTokenColumns(token),
    storefront: storefront.toLowerCase(),
    status: "valid",
    lastValidatedAt: new Date(),
    lastError: null,
  });
}

/** API-safe staging step: encrypt only. Provider validation belongs to the durable worker. */
export async function stageOwnerAppleAuthorization(
  store: AppleAuthorizationStore,
  token: string,
  storefrontHint = process.env.APPLE_STOREFRONT ?? "br",
): Promise<void> {
  if (!token.trim()) throw new Error("Apple Music user token is required");
  await store.saveAppleAuthorization({
    ...encryptedTokenColumns(token),
    storefront: /^[a-z]{2}$/i.test(storefrontHint) ? storefrontHint.toLowerCase() : "br",
    status: "unverified",
    lastValidatedAt: null,
    lastError: null,
  });
}

export async function authorizeOwnerAppleMusic(
  store: AppleAuthorizationStore,
  token: string,
  signal?: AbortSignal,
): Promise<{ storefront: string }> {
  if (!token.trim()) throw new Error("Apple Music user token is required");
  const storefront = await new AppleMusicClient(token.trim()).validateAuthorization(signal);
  signal?.throwIfAborted();
  await saveOwnerAppleAuthorization(store, token, storefront);
  return { storefront };
}

export interface DeveloperTokenOptions {
  origin?: string;
  ttlSeconds?: number;
}

/**
 * Developer credentials are deployment secrets.  The unknown parameter keeps
 * the old createDeveloperToken(repository) call source-compatible during the
 * API migration; repository values are deliberately ignored.
 */
export async function createDeveloperToken(optionsOrLegacy?: DeveloperTokenOptions | unknown): Promise<string> {
  const options = optionsOrLegacy && typeof optionsOrLegacy === "object" && ("origin" in optionsOrLegacy || "ttlSeconds" in optionsOrLegacy)
    ? optionsOrLegacy as DeveloperTokenOptions
    : {};
  const teamId = requireSecret("APPLE_TEAM_ID");
  const keyId = requireSecret("APPLE_KEY_ID");
  const privateKey = requirePrivateKey();
  const now = Math.floor(Date.now() / 1_000);
  const ttlSeconds = Math.min(Math.max(options.ttlSeconds ?? 15 * 60, 60), 15 * 60);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims: Record<string, string | number | string[]> = { iss: teamId, iat: now, exp: now + ttlSeconds };
  // Apple defines the web-only origin claim as an array, even when a token is
  // restricted to a single origin. Catalog requests currently tolerate a
  // string, but MusicKit's user-authorization service can reject that shape.
  if (options.origin) claims.origin = [new URL(options.origin).origin];
  const payload = base64url(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(body), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${body}.${base64url(signature)}`;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Request aborted"));
  }, { once: true });
});

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after")?.trim() ?? "";
  const retryAfterSeconds = Number(header);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1_000, 15_000);
  }
  const retryAt = Date.parse(header);
  if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), 15_000);
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 8_000);
}

async function parsePayload(response: Response): Promise<any> {
  if (response.status === 204) return null;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Apple response exceeded the configured size limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Apple response exceeded the configured size limit");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error("Apple returned malformed JSON"); }
}

export interface AppleRequestOptions extends RequestInit {
  retrySafe?: boolean;
  signal?: AbortSignal;
}

export class AppleMusicClient {
  constructor(
    private readonly musicUserToken?: string,
    private readonly storefront?: string,
  ) {}

  async request(path: string, options: AppleRequestOptions = {}): Promise<any> {
    if (!path.startsWith("/v1/")) throw new Error("Apple API path is not allowed");
    const method = (options.method ?? "GET").toUpperCase();
    const retrySafe = options.retrySafe ?? method === "GET";
    const maxAttempts = retrySafe ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response | null = null;
      try {
        response = await fetch(`${APPLE_API}${path}`, {
          ...options,
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${await createDeveloperToken()}`,
            ...(this.musicUserToken ? { "Music-User-Token": this.musicUserToken } : {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers ?? {}),
          },
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        if (response.status >= 300 && response.status < 400) {
          throw new AppleApiError("Apple API redirects are not allowed", response.status, false, method !== "GET");
        }
        const payload = await parsePayload(response);
        if (response.ok) return payload;
        if (this.musicUserToken && (response.status === 401 || response.status === 403)) {
          throw new AppleAuthorizationRequiredError(response.status);
        }
        const detail = payload?.errors?.[0]?.detail ?? payload?.errors?.[0]?.title ?? `Apple Music request failed (${response.status})`;
        const retriable = response.status === 429 || response.status >= 500;
        const delayMs = retriable ? retryDelay(response, attempt) : null;
        const error = new AppleApiError(
          detail,
          response.status,
          retriable,
          method !== "GET" && retriable,
          delayMs,
        );
        if (!retriable || attempt === maxAttempts - 1) throw error;
        lastError = error;
        await wait(delayMs!, options.signal);
      } catch (error) {
        if (error instanceof AppleAuthorizationRequiredError) throw error;
        if (error instanceof AppleApiError) {
          if (!error.retriable || attempt === maxAttempts - 1) throw error;
          lastError = error;
          continue;
        }
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        lastError = error;
        if (!retrySafe || attempt === maxAttempts - 1) {
          throw new AppleApiError("Apple Music could not be reached", null, true, method !== "GET");
        }
        await wait(retryDelay(response, attempt), options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new AppleApiError("Apple Music request failed", null, true);
  }

  async validateAuthorization(signal?: AbortSignal): Promise<string> {
    const payload = await this.request("/v1/me/storefront", { signal });
    const storefront = payload?.data?.[0]?.id;
    if (!storefront) throw new Error("Apple did not return the owner storefront");
    return String(storefront).toLowerCase();
  }

  async createLibraryPlaylist(name: string, description: string, signal?: AbortSignal): Promise<{ id: string; url: string | null }> {
    const payload = await this.request("/v1/me/library/playlists", {
      method: "POST",
      body: JSON.stringify({
        attributes: {
          name: name.slice(0, 240),
          description: description.slice(0, 1_000),
          isPublic: true,
        },
      }),
      retrySafe: false,
      signal,
    });
    const item = payload?.data?.[0];
    if (!item?.id) throw new Error("Apple did not return a playlist ID");
    // A library resource can expose a catalog-looking URL before it is public.
    // Never persist that URL until Apple also reports the library playlist as
    // public; otherwise a link that works for the owner can fail for visitors.
    return { id: String(item.id), url: libraryPlaylistIsPublic(item) ? playlistShareUrl(item) : null };
  }

  async appendCatalogTracks(playlistId: string, catalogIds: readonly string[], signal?: AbortSignal): Promise<void> {
    if (catalogIds.length < 1 || catalogIds.length > 25) throw new Error("Apple append batches must contain 1-25 tracks");
    await this.request(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: "POST",
      body: JSON.stringify({ data: catalogIds.map((id) => ({ id, type: "songs" })) }),
      retrySafe: false,
      signal,
    });
  }

  async getOrderedPlaylistCatalogIds(playlistId: string, signal?: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    let path: string | null = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
    for (let page = 0; path && page < 200; page += 1) {
      signal?.throwIfAborted();
      let payload: any;
      try {
        payload = await this.request(path, { signal });
      } catch (error) {
        // Apple can expose a newly-created library playlist before its empty
        // tracks relationship exists. Confirm the parent before interpreting
        // that first-page 404 as an empty playlist; a missing parent remains a
        // real 404 so the publisher can replace the stale resource.
        if (page === 0 && error instanceof AppleApiError && error.status === 404) {
          const playlist = await this.getLibraryPlaylist(playlistId, signal);
          if (playlist) return [];
        }
        throw error;
      }
      for (const track of payload?.data ?? []) {
        const catalogId = track.attributes?.playParams?.catalogId ?? track.relationships?.catalog?.data?.[0]?.id;
        if (!catalogId) throw new Error("Apple returned a library track without a catalog identifier");
        ids.push(String(catalogId));
      }
      path = normalizeAppleNext(payload?.next);
    }
    if (path) throw new Error("Apple playlist pagination exceeded the safety limit");
    return ids;
  }

  async getCatalogRecordingKeys(catalogIds: readonly string[], signal?: AbortSignal): Promise<Record<string, string>> {
    if (!this.storefront || !/^[a-z]{2}$/i.test(this.storefront)) return {};
    const unique = [...new Set(catalogIds.filter((id) => /^[A-Za-z0-9._-]{1,200}$/u.test(id)))];
    const keys: Record<string, string> = {};
    for (let offset = 0; offset < unique.length; offset += 100) {
      signal?.throwIfAborted();
      const ids = unique.slice(offset, offset + 100);
      const params = new URLSearchParams({ ids: ids.join(",") });
      const payload = await this.request(
        `/v1/catalog/${encodeURIComponent(this.storefront.toLowerCase())}/songs?${params}`,
        { signal },
      );
      for (const item of payload?.data ?? []) {
        const id = typeof item?.id === "string" ? item.id : "";
        if (!id) continue;
        const isrc = typeof item?.attributes?.isrc === "string" ? item.attributes.isrc.trim().toUpperCase() : "";
        keys[id] = isrc ? `isrc:${isrc}` : `apple:${id}`;
      }
    }
    return keys;
  }

  async getLibraryPlaylist(playlistId: string, signal?: AbortSignal): Promise<any | null> {
    try {
      const payload = await this.request(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}?include=catalog`, { signal });
      return payload?.data?.[0] ?? null;
    } catch (error) {
      if (error instanceof AppleApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listLibraryPlaylists(signal?: AbortSignal): Promise<any[]> {
    const items: any[] = [];
    let path: string | null = "/v1/me/library/playlists?limit=100";
    for (let page = 0; path && page < 100; page += 1) {
      signal?.throwIfAborted();
      const payload = await this.request(path, { signal });
      if (!Array.isArray(payload?.data)) throw new Error("Apple returned an invalid library-playlist page");
      items.push(...payload.data);
      path = normalizeAppleNext(payload?.next);
    }
    if (path) throw new Error("Apple library-playlist pagination exceeded the safety limit");
    return items;
  }

  async getLibraryPlaylistCatalog(playlistId: string, signal?: AbortSignal): Promise<any | null> {
    try {
      const payload = await this.request(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/catalog`, { signal });
      return payload?.data?.[0] ?? null;
    } catch (error) {
      if (error instanceof AppleApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getCatalogPlaylist(catalogId: string, signal?: AbortSignal): Promise<any | null> {
    if (!this.storefront || !/^[a-z]{2}$/i.test(this.storefront)) return null;
    try {
      const payload = await this.request(
        `/v1/catalog/${encodeURIComponent(this.storefront.toLowerCase())}/playlists/${encodeURIComponent(catalogId)}`,
        { signal },
      );
      return payload?.data?.[0] ?? null;
    } catch (error) {
      if (error instanceof AppleApiError && error.status === 404) return null;
      throw error;
    }
  }

  async findLibraryPlaylistByMarker(marker: string, signal?: AbortSignal): Promise<any | null> {
    let path: string | null = "/v1/me/library/playlists?limit=100";
    for (let page = 0; path && page < 100; page += 1) {
      signal?.throwIfAborted();
      const payload = await this.request(path, { signal });
      const match = (payload?.data ?? []).find((item: any) => String(item.attributes?.description?.standard ?? item.attributes?.description ?? "").includes(marker));
      if (match) return match;
      path = normalizeAppleNext(payload?.next);
    }
    return null;
  }

  async resolveLibraryPlaylistShareUrl(playlistId: string, signal?: AbortSignal): Promise<string | null> {
    const libraryPlaylist = await this.getLibraryPlaylist(playlistId, signal);
    if (!libraryPlaylistIsPublic(libraryPlaylist)) return null;
    const direct = libraryPlaylist ? playlistShareUrl(libraryPlaylist) : null;
    if (direct) return direct;

    const includedCatalog = libraryPlaylist?.relationships?.catalog?.data?.[0] ?? null;
    const includedUrl = includedCatalog ? playlistShareUrl(includedCatalog) : null;
    if (includedUrl) return includedUrl;

    let catalogId = playlistCatalogId(libraryPlaylist) ?? playlistCatalogId(includedCatalog);
    const relatedCatalog = await this.getLibraryPlaylistCatalog(playlistId, signal);
    const relatedUrl = relatedCatalog ? playlistShareUrl(relatedCatalog) : null;
    if (relatedUrl) return relatedUrl;
    catalogId ??= playlistCatalogId(relatedCatalog);

    if (!catalogId) return null;
    const catalogPlaylist = await this.getCatalogPlaylist(catalogId, signal);
    return catalogPlaylist ? playlistShareUrl(catalogPlaylist) : null;
  }

  async pollStableShareUrl(playlistId: string, attempts = 100, delayMs = 3_000, signal?: AbortSignal): Promise<string> {
    let previous: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      signal?.throwIfAborted();
      const current = await this.resolveLibraryPlaylistShareUrl(playlistId, signal);
      if (current && current === previous) return current;
      previous = current;
      if (attempt < attempts - 1) await wait(delayMs, signal);
    }
    throw new AppleShareLinkUnavailableError(playlistId);
  }
}

function normalizeAppleNext(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("/v1/")) return value;
  const parsed = new URL(value, APPLE_API);
  if (parsed.origin !== APPLE_API || !parsed.pathname.startsWith("/v1/")) throw new Error("Apple returned an invalid pagination URL");
  return `${parsed.pathname}${parsed.search}`;
}

export function playlistShareUrl(item: any): string | null {
  const candidates = [item?.attributes?.url, item?.attributes?.playParams?.shareUrl];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "music.apple.com" && /\/playlist\//i.test(url.pathname)) return url.toString();
    } catch { /* wait for Apple to provide a valid public URL */ }
  }
  return null;
}

export function libraryPlaylistIsPublic(item: any): boolean {
  return item?.type === "library-playlists" && item?.attributes?.isPublic === true;
}

export function playlistCatalogId(item: any): string | null {
  const candidates = [
    item?.relationships?.catalog?.data?.[0]?.id,
    item?.attributes?.playParams?.globalId,
    item?.type === "playlists" ? item?.id : null,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && /^pl\.[A-Za-z0-9_-]{1,200}$/u.test(value)) return value;
  }
  return null;
}

export async function authorizedAppleClient(
  store: Pick<AppleAuthorizationStore, "getAppleAuthorization">,
): Promise<{ client: AppleMusicClient; authorization: AppleAuthorizationRecord }> {
  const authorization = await store.getAppleAuthorization();
  if (!authorization || authorization.status !== "valid") throw new AppleAuthorizationRequiredError(401);
  return {
    client: new AppleMusicClient(decryptMusicUserToken(tokenEnvelope(authorization)), authorization.storefront),
    authorization,
  };
}

export async function validateStoredAppleAuthorization(store: AppleAuthorizationStore, signal?: AbortSignal): Promise<string> {
  try {
    const { client } = await authorizedAppleClient(store);
    const storefront = await client.validateAuthorization(signal);
    if (storefront !== (await store.getAppleAuthorization())?.storefront) {
      throw new Error("Apple owner storefront changed; reauthorize to store the new storefront");
    }
    await store.updateAppleAuthorizationStatus("valid", null);
    return storefront;
  } catch (error) {
    if (error instanceof AppleAuthorizationRequiredError) {
      await store.updateAppleAuthorizationStatus("reauthorization_required", error.message);
    }
    throw error;
  }
}

export interface AppleAuthorizationJobRepository extends AppleAuthorizationStore {
  updateAppleAuthorizationValidation(input: {
    expectedCiphertext: string;
    expectedKeyVersion: string;
    storefront?: string;
    status: "valid" | "reauthorization_required";
    lastError?: string | null;
  }): Promise<boolean>;
}

export interface ApplePublicationRecoveryRepository {
  getAppleAuthorization(): Promise<AppleAuthorizationRecord | null>;
  listWaitingPublicationManifests(): Promise<Array<{ manifestId: string; runId: string }>>;
  enqueueWaitingPublicationRecovery(input: {
    manifestId: string;
    runId: string;
    dedupeKey: string;
  }): Promise<boolean>;
}

export interface AppleAuthorizationRecoveryRepository {
  getAppleAuthorization(): Promise<AppleAuthorizationRecord | null>;
  enqueueJob(input: {
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    maxAttempts?: number;
  }): Promise<unknown>;
}

/** Recover the API-save/queue crash window without validating a user token in the startup path. */
export async function recoverUnverifiedAppleAuthorizationJob(
  repository: AppleAuthorizationRecoveryRepository,
): Promise<boolean> {
  const authorization = await repository.getAppleAuthorization();
  if (!authorization || authorization.status !== "unverified") return false;
  const authorizationGeneration = appleAuthorizationGeneration(authorization);
  await repository.enqueueJob({
    kind: "apple_authorization",
    payload: { authorizationGeneration },
    dedupeKey: appleAuthorizationJobDedupeKey(authorization),
    maxAttempts: 6,
  });
  return true;
}

/**
 * Reconcile publications that were paused for owner reauthorization.
 *
 * This deliberately lives outside the authorization-validation job. A valid
 * Music User Token must remain valid even when a transient database failure
 * prevents one of the waiting publication jobs from being queued immediately.
 */
export async function recoverWaitingApplePublicationJobs(
  repository: ApplePublicationRecoveryRepository,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const authorization = await repository.getAppleAuthorization();
  if (!authorization || authorization.status !== "valid") return 0;
  const authorizationGeneration = appleAuthorizationGeneration(authorization);
  const validationEpoch = authorization.lastValidatedAt?.getTime().toString(36) ?? "legacy";
  let queued = 0;
  for (const { manifestId, runId } of await repository.listWaitingPublicationManifests()) {
    signal?.throwIfAborted();
    const created = await repository.enqueueWaitingPublicationRecovery({
      manifestId,
      runId,
      dedupeKey: `publication:${manifestId}:reauth:${authorizationGeneration}:${validationEpoch}`,
    });
    if (created) queued += 1;
  }
  return queued;
}

export async function processAppleAuthorizationJob(
  repository: AppleAuthorizationJobRepository,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const authorization = await repository.getAppleAuthorization();
  if (!authorization) return;
  const authorizationGeneration = appleAuthorizationGeneration(authorization);
  if (typeof payload.authorizationGeneration === "string" && payload.authorizationGeneration !== authorizationGeneration) return;
  const token = decryptMusicUserToken(tokenEnvelope(authorization));
  let storefront: string;
  try {
    storefront = await new AppleMusicClient(token).validateAuthorization(signal);
  } catch (error) {
    if (error instanceof AppleAuthorizationRequiredError) {
      await repository.updateAppleAuthorizationValidation({
        expectedCiphertext: authorization.ciphertext,
        expectedKeyVersion: authorization.keyVersion,
        status: "reauthorization_required",
        lastError: error.message,
      });
      return;
    }
    throw error;
  }
  signal?.throwIfAborted();
  const stillCurrent = await repository.updateAppleAuthorizationValidation({
    expectedCiphertext: authorization.ciphertext,
    expectedKeyVersion: authorization.keyVersion,
    storefront,
    status: "valid",
    lastError: null,
  });
  if (!stillCurrent) return;
}

export async function searchAppleCatalog(storefront: string, query: string, signal?: AbortSignal): Promise<CatalogSong[]>;
export async function searchAppleCatalog(legacyRepository: unknown, storefront: string, query: string, signal?: AbortSignal): Promise<CatalogSong[]>;
export async function searchAppleCatalog(first: string | unknown, second: string, third?: string | AbortSignal, fourth?: AbortSignal): Promise<CatalogSong[]> {
  const storefront = typeof first === "string" ? first : second;
  const query = typeof first === "string" ? second : typeof third === "string" ? third : "";
  const signal = typeof first === "string" ? third as AbortSignal | undefined : fourth;
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  const params = new URLSearchParams({ term: query.slice(0, 300), types: "songs", limit: "25" });
  const payload = await new AppleMusicClient().request(`/v1/catalog/${encodeURIComponent(storefront.toLowerCase())}/search?${params}`, { signal });
  return appleSongs(payload?.results?.songs?.data);
}

function stringGenres(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((genre: unknown): genre is string => typeof genre === "string").slice(0, 20)
    : [];
}

function appleSongs(items: unknown, limit = 100): CatalogSong[] {
  return (Array.isArray(items) ? items : []).slice(0, limit).map((item: any) => {
    const contentRating = item.attributes?.contentRating;
    return {
      id: String(item.id),
      name: item.attributes?.name ?? "",
      artistName: item.attributes?.artistName ?? "",
      albumName: item.attributes?.albumName ?? "",
      genreNames: stringGenres(item.attributes?.genreNames),
      releaseDate: item.attributes?.releaseDate,
      durationInMillis: item.attributes?.durationInMillis,
      isrc: item.attributes?.isrc,
      url: item.attributes?.url,
      artworkUrl: item.attributes?.artwork?.url,
      ...(contentRating === "clean" || contentRating === "explicit" ? { contentRating } : {}),
    };
  });
}

function appleArtists(items: unknown, limit = 25): AppleCatalogArtist[] {
  return (Array.isArray(items) ? items : []).slice(0, limit).flatMap((item: any) => {
    const id = typeof item?.id === "string" ? item.id : "";
    const name = typeof item?.attributes?.name === "string" ? item.attributes.name.trim() : "";
    if (!id || !name) return [];
    return [{
      id,
      name,
      genreNames: stringGenres(item.attributes?.genreNames),
      ...(typeof item.attributes?.url === "string" ? { url: item.attributes.url } : {}),
    }];
  });
}

function appleAlbums(items: unknown, limit = 100): AppleCatalogAlbum[] {
  return (Array.isArray(items) ? items : []).slice(0, limit).flatMap((item: any) => {
    const id = typeof item?.id === "string" ? item.id : "";
    const name = typeof item?.attributes?.name === "string" ? item.attributes.name.trim() : "";
    if (!id || !name) return [];
    return [{
      id,
      name,
      artistName: typeof item.attributes?.artistName === "string" ? item.attributes.artistName : "",
      genreNames: stringGenres(item.attributes?.genreNames),
      ...(typeof item.attributes?.releaseDate === "string" ? { releaseDate: item.attributes.releaseDate } : {}),
      ...(Number.isInteger(item.attributes?.trackCount) ? { trackCount: Number(item.attributes.trackCount) } : {}),
      ...(typeof item.attributes?.isSingle === "boolean" ? { isSingle: item.attributes.isSingle } : {}),
      ...(typeof item.attributes?.isCompilation === "boolean" ? { isCompilation: item.attributes.isCompilation } : {}),
      ...(typeof item.attributes?.recordLabel === "string" ? { recordLabel: item.attributes.recordLabel } : {}),
      ...(typeof item.attributes?.url === "string" ? { url: item.attributes.url } : {}),
    }];
  });
}

function appleDescription(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 2_000);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const text = typeof record.standard === "string"
    ? record.standard
    : typeof record.short === "string"
      ? record.short
      : "";
  return text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function applePlaylists(items: unknown, limit = 25): AppleCatalogPlaylist[] {
  return (Array.isArray(items) ? items : []).slice(0, limit).flatMap((item: any) => {
    const id = typeof item?.id === "string" ? item.id : "";
    const name = typeof item?.attributes?.name === "string" ? item.attributes.name.trim() : "";
    if (!id || !name) return [];
    return [{
      id,
      name,
      curatorName: typeof item.attributes?.curatorName === "string" ? item.attributes.curatorName : "",
      description: appleDescription(item.attributes?.description),
      ...(typeof item.attributes?.playlistType === "string" ? { playlistType: item.attributes.playlistType } : {}),
      ...(typeof item.attributes?.url === "string" ? { url: item.attributes.url } : {}),
    }];
  });
}

function checkedStorefront(storefront: string): string {
  if (!/^[a-z]{2}$/iu.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  return storefront.toLowerCase();
}

function checkedNumericCatalogId(id: string, resource: string): string {
  const normalized = id.trim();
  if (!/^\d{1,32}$/u.test(normalized)) throw new Error(`Apple ${resource} ID is invalid`);
  return normalized;
}

/**
 * Search several Apple resource classes in one request. These results prove
 * storefront identity and availability only; callers must attach an
 * independent scope binding before a song becomes playlist-eligible.
 */
export async function searchAppleCatalogResources(
  storefront: string,
  query: string,
  types: readonly AppleCatalogSearchType[] = ["songs", "artists", "albums", "playlists"],
  limit = 25,
  signal?: AbortSignal,
  next: string | null = null,
): Promise<AppleCatalogSearchResult> {
  const normalizedStorefront = checkedStorefront(storefront);
  const allowed = new Set<AppleCatalogSearchType>(["songs", "artists", "albums", "playlists"]);
  const normalizedTypes = [...new Set(types)].filter((type) => allowed.has(type));
  if (normalizedTypes.length < 1) throw new Error("At least one Apple catalog search type is required");
  const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const params = new URLSearchParams({
    term: query.trim().slice(0, 300),
    types: normalizedTypes.join(","),
    limit: String(boundedLimit),
  });
  if (!params.get("term")) throw new Error("Apple catalog search term is required");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/search?${params}`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/search?`)) {
    throw new Error("Apple search pagination scope changed unexpectedly");
  }
  const continued = new URL(path, APPLE_API);
  const continuedTypes = (continued.searchParams.get("types") ?? "").split(",").filter(Boolean);
  if (continued.searchParams.get("term") !== params.get("term")
    || continuedTypes.length < 1
    || continuedTypes.some((type) => !normalizedTypes.includes(type as AppleCatalogSearchType))) {
    throw new Error("Apple search pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  const nextByType = Object.fromEntries(normalizedTypes.flatMap((type) => {
    const cursor = normalizeAppleNext(payload?.results?.[type]?.next);
    return cursor ? [[type, cursor]] : [];
  })) as Partial<Record<AppleCatalogSearchType, string>>;
  return {
    songs: appleSongs(payload?.results?.songs?.data, boundedLimit),
    artists: appleArtists(payload?.results?.artists?.data, boundedLimit),
    albums: appleAlbums(payload?.results?.albums?.data, boundedLimit),
    playlists: applePlaylists(payload?.results?.playlists?.data, boundedLimit),
    ...(Object.keys(nextByType).length > 0 ? { next: nextByType } : {}),
  };
}

export async function getAppleCatalogPlaylistTracks(
  storefront: string,
  playlistId: string,
  next: string | null = null,
  signal?: AbortSignal,
): Promise<AppleCatalogPage<CatalogSong>> {
  const normalizedStorefront = checkedStorefront(storefront);
  const normalizedId = playlistId.trim();
  if (!/^pl\.[A-Za-z0-9_-]{1,200}$/u.test(normalizedId)) throw new Error("Apple catalog playlist ID is invalid");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/playlists/${encodeURIComponent(normalizedId)}/tracks?limit=100`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/playlists/${encodeURIComponent(normalizedId)}/tracks`)) {
    throw new Error("Apple playlist pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  return { items: appleSongs(payload?.data, 100), next: normalizeAppleNext(payload?.next) };
}

export async function getAppleCatalogAlbumTracks(
  storefront: string,
  albumId: string,
  next: string | null = null,
  signal?: AbortSignal,
): Promise<AppleCatalogPage<CatalogSong>> {
  const normalizedStorefront = checkedStorefront(storefront);
  const normalizedId = checkedNumericCatalogId(albumId, "album");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/albums/${normalizedId}/tracks?limit=100`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/albums/${normalizedId}/tracks`)) {
    throw new Error("Apple album pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  return { items: appleSongs(payload?.data, 100), next: normalizeAppleNext(payload?.next) };
}

export async function getAppleCatalogArtistTopSongs(
  storefront: string,
  artistId: string,
  next: string | null = null,
  signal?: AbortSignal,
): Promise<AppleCatalogPage<CatalogSong>> {
  const normalizedStorefront = checkedStorefront(storefront);
  const normalizedId = checkedNumericCatalogId(artistId, "artist");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/artists/${normalizedId}/view/top-songs?limit=25`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/artists/${normalizedId}/view/top-songs`)) {
    throw new Error("Apple artist pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  return { items: appleSongs(payload?.data, 25), next: normalizeAppleNext(payload?.next) };
}

export type AppleArtistAlbumView =
  | "appears-on-albums"
  | "compilation-albums"
  | "featured-albums"
  | "full-albums"
  | "latest-release"
  | "live-albums"
  | "singles";

export async function getAppleCatalogArtistAlbums(
  storefront: string,
  artistId: string,
  view: AppleArtistAlbumView,
  next: string | null = null,
  signal?: AbortSignal,
): Promise<AppleCatalogPage<AppleCatalogAlbum>> {
  const normalizedStorefront = checkedStorefront(storefront);
  const normalizedId = checkedNumericCatalogId(artistId, "artist");
  const allowed = new Set<AppleArtistAlbumView>([
    "appears-on-albums",
    "compilation-albums",
    "featured-albums",
    "full-albums",
    "latest-release",
    "live-albums",
    "singles",
  ]);
  if (!allowed.has(view)) throw new Error("Apple artist album view is invalid");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/artists/${normalizedId}/view/${view}?limit=25`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/artists/${normalizedId}/view/${view}`)) {
    throw new Error("Apple artist pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  return { items: appleAlbums(payload?.data, 25), next: normalizeAppleNext(payload?.next) };
}

export async function getAppleCatalogSimilarArtists(
  storefront: string,
  artistId: string,
  next: string | null = null,
  signal?: AbortSignal,
): Promise<AppleCatalogPage<AppleCatalogArtist>> {
  const normalizedStorefront = checkedStorefront(storefront);
  const normalizedId = checkedNumericCatalogId(artistId, "artist");
  const initial = `/v1/catalog/${encodeURIComponent(normalizedStorefront)}/artists/${normalizedId}/view/similar-artists?limit=25`;
  const path = next ? normalizeAppleNext(next) : initial;
  if (!path || !path.startsWith(`/v1/catalog/${normalizedStorefront}/artists/${normalizedId}/view/similar-artists`)) {
    throw new Error("Apple similar-artist pagination scope changed unexpectedly");
  }
  const payload = await new AppleMusicClient().request(path, { signal });
  return { items: appleArtists(payload?.data, 25), next: normalizeAppleNext(payload?.next) };
}

export async function lookupAppleCatalogByIsrc(storefront: string, isrc: string, signal?: AbortSignal): Promise<CatalogSong[]> {
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  const normalizedIsrc = isrc.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalizedIsrc)) return [];
  const params = new URLSearchParams({ "filter[isrc]": normalizedIsrc, limit: "25" });
  const payload = await new AppleMusicClient().request(
    `/v1/catalog/${encodeURIComponent(storefront.toLowerCase())}/songs?${params}`,
    { signal },
  );
  return appleSongs(payload?.data);
}

export async function lookupAppleCatalogByIds(
  storefront: string,
  catalogIds: readonly string[],
  signal?: AbortSignal,
): Promise<CatalogSong[]> {
  if (!/^[a-z]{2}$/iu.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  if (catalogIds.length < 1 || catalogIds.length > 25) throw new Error("Apple catalog-ID lookups require 1-25 IDs");
  const normalized = catalogIds.map((id) => id.trim());
  if (normalized.some((id) => !/^\d{1,32}$/u.test(id)) || new Set(normalized).size !== normalized.length) {
    throw new Error("Apple catalog-ID lookups require unique numeric song IDs");
  }
  const params = new URLSearchParams({ ids: normalized.join(",") });
  const payload = await new AppleMusicClient().request(
    `/v1/catalog/${encodeURIComponent(storefront.toLowerCase())}/songs?${params}`,
    { signal },
  );
  const songs = appleSongs(payload?.data);
  if (songs.some((song) => !normalized.includes(song.id))) throw new Error("Apple returned an unexpected catalog song");
  return songs;
}
