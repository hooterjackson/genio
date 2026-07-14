import { randomUUID } from "node:crypto";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  AppleMusicClient,
  ApplePlaylistDivergedError,
  AppleShareLinkUnavailableError,
  type AppleAuthorizationRecord,
  type AppleAuthorizationStore,
  authorizedAppleClient,
} from "./apple.ts";
import { exactOrderedPrefix } from "./publisher.ts";

export const APPLE_SMOKE_NAME_PREFIX = "[NEEDLE TEST]";
export const APPLE_SMOKE_CONFIRMATION_FLAG = "--confirm-live-write";
const MAX_SMOKE_TRACKS = 25;

export interface AppleSmokeInput {
  name: string;
  catalogIds: string[];
  confirmLiveWrite: boolean;
}

export interface AppleSmokeResult {
  name: string;
  storefront: string;
  playlistId: string;
  shareUrl: string;
  orderedCatalogIds: string[];
}

export interface AppleSmokeClient {
  validateAuthorization(signal?: AbortSignal): Promise<string>;
  findLibraryPlaylistByMarker(marker: string, signal?: AbortSignal): Promise<any | null>;
  createLibraryPlaylist(name: string, description: string, signal?: AbortSignal): Promise<{ id: string; url: string | null }>;
  appendCatalogTracks(playlistId: string, catalogIds: readonly string[], signal?: AbortSignal): Promise<void>;
  getOrderedPlaylistCatalogIds(playlistId: string, signal?: AbortSignal): Promise<string[]>;
  pollStableShareUrl(playlistId: string, attempts?: number, delayMs?: number, signal?: AbortSignal): Promise<string>;
}

interface AppleSmokeRuntime {
  authorize?: (store: Pick<AppleAuthorizationStore, "getAppleAuthorization">) => Promise<{
    client: AppleSmokeClient;
    authorization: AppleAuthorizationRecord;
  }>;
  pollAttempts?: number;
  pollDelayMs?: number;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Apple smoke test aborted"));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Apple smoke test aborted"));
  }, { once: true });
});

export function validateAppleSmokeInput(input: AppleSmokeInput): AppleSmokeInput {
  const name = input.name.trim();
  if (!input.confirmLiveWrite) {
    throw new Error(`Live Apple writes require ${APPLE_SMOKE_CONFIRMATION_FLAG}`);
  }
  if (!name.startsWith(`${APPLE_SMOKE_NAME_PREFIX} `)) {
    throw new Error(`Smoke playlist names must begin with "${APPLE_SMOKE_NAME_PREFIX} "`);
  }
  if (name.length > 240) throw new Error("Smoke playlist names cannot exceed 240 characters");
  if (input.catalogIds.length < 1 || input.catalogIds.length > MAX_SMOKE_TRACKS) {
    throw new Error(`Apple smoke tests require 1-${MAX_SMOKE_TRACKS} catalog IDs`);
  }
  const catalogIds = input.catalogIds.map((catalogId) => catalogId.trim());
  if (catalogIds.some((catalogId) => !/^\d{1,32}$/.test(catalogId))) {
    throw new Error("Apple catalog IDs must contain only 1-32 digits");
  }
  return { name, catalogIds, confirmLiveWrite: true };
}

export function parseAppleSmokeArgs(argv: readonly string[]): AppleSmokeInput {
  let name = "";
  let confirmLiveWrite = false;
  const catalogIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === APPLE_SMOKE_CONFIRMATION_FLAG) {
      confirmLiveWrite = true;
    } else if (argument === "--name") {
      const value = argv[index + 1];
      if (!value) throw new Error("--name requires a value");
      name = value;
      index += 1;
    } else if (argument === "--catalog-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--catalog-id requires a value");
      catalogIds.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown Apple smoke argument: ${argument}`);
    }
  }
  return validateAppleSmokeInput({ name, catalogIds, confirmLiveWrite });
}

export async function waitForExactApplePlaylistOrder(
  client: Pick<AppleSmokeClient, "getOrderedPlaylistCatalogIds">,
  playlistId: string,
  expected: readonly string[],
  options: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const attempts = Math.min(Math.max(Math.floor(options.attempts ?? 12), 1), 120);
  const delayMs = Math.min(Math.max(Math.floor(options.delayMs ?? 1_000), 0), 10_000);
  let observed: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    observed = await client.getOrderedPlaylistCatalogIds(playlistId, options.signal);
    if (!exactOrderedPrefix(observed, expected)) {
      throw new ApplePlaylistDivergedError(playlistId, observed.length);
    }
    if (observed.length === expected.length) return observed;
    if (attempt < attempts - 1) await wait(delayMs, options.signal);
  }
  throw new AppleApiError("Apple playlist reads did not reach the expected ordered length", null, true, false);
}

async function recoverCreatedPlaylist(
  client: Pick<AppleSmokeClient, "findLibraryPlaylistByMarker">,
  marker: string,
  options: { attempts: number; delayMs: number; signal?: AbortSignal },
): Promise<any | null> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const recovered = await client.findLibraryPlaylistByMarker(marker, options.signal);
    if (recovered?.id) return recovered;
    if (attempt < options.attempts - 1) await wait(options.delayMs, options.signal);
  }
  return null;
}

export async function runApplePublicationSmoke(
  store: Pick<AppleAuthorizationStore, "getAppleAuthorization">,
  rawInput: AppleSmokeInput,
  signal?: AbortSignal,
  runtime: AppleSmokeRuntime = {},
): Promise<AppleSmokeResult> {
  const input = validateAppleSmokeInput(rawInput);
  const pollAttempts = Math.min(Math.max(Math.floor(runtime.pollAttempts ?? 100), 2), 120);
  const pollDelayMs = Math.min(Math.max(Math.floor(runtime.pollDelayMs ?? 3_000), 0), 10_000);
  const authorize = runtime.authorize ?? (async (authorizationStore) => {
    const authorized = await authorizedAppleClient(authorizationStore);
    return { client: authorized.client as AppleMusicClient, authorization: authorized.authorization };
  });
  const { client, authorization } = await authorize(store);
  signal?.throwIfAborted();
  const storefront = (await client.validateAuthorization(signal)).toLowerCase();
  if (storefront !== authorization.storefront.toLowerCase()) {
    throw new Error("The live Apple storefront does not match the stored owner authorization");
  }
  const configuredStorefront = process.env.APPLE_STOREFRONT?.trim().toLowerCase();
  if (configuredStorefront && storefront !== configuredStorefront) {
    throw new Error("The live Apple storefront does not match APPLE_STOREFRONT");
  }

  const marker = `Needle smoke ${randomUUID()}`;
  const description = `Temporary publication feasibility test. Delete after validation.\n\n${marker}`;
  let playlistId: string;
  try {
    const created = await client.createLibraryPlaylist(input.name, description, signal);
    playlistId = created.id;
  } catch (error) {
    if (!(error instanceof AppleApiError) || !error.uncertainMutation) throw error;
    const recovered = await recoverCreatedPlaylist(client, marker, { attempts: pollAttempts, delayMs: pollDelayMs, signal });
    if (!recovered?.id) throw error;
    playlistId = String(recovered.id);
  }

  let appendedCount = 0;
  while (appendedCount < input.catalogIds.length) {
    signal?.throwIfAborted();
    const batch = input.catalogIds.slice(appendedCount, appendedCount + 25);
    const expectedAfterBatch = input.catalogIds.slice(0, appendedCount + batch.length);
    try {
      await client.appendCatalogTracks(playlistId, batch, signal);
    } catch (error) {
      try {
        await waitForExactApplePlaylistOrder(client, playlistId, expectedAfterBatch, {
          attempts: pollAttempts,
          delayMs: pollDelayMs,
          signal,
        });
      } catch (reconciliationError) {
        if (reconciliationError instanceof ApplePlaylistDivergedError) throw reconciliationError;
        throw error;
      }
    }
    await waitForExactApplePlaylistOrder(client, playlistId, expectedAfterBatch, {
      attempts: pollAttempts,
      delayMs: pollDelayMs,
      signal,
    });
    appendedCount += batch.length;
  }

  const orderedCatalogIds = await waitForExactApplePlaylistOrder(client, playlistId, input.catalogIds, {
    attempts: pollAttempts,
    delayMs: pollDelayMs,
    signal,
  });
  const shareUrl = await client.pollStableShareUrl(playlistId, pollAttempts, Math.max(pollDelayMs, 250), signal);
  return { name: input.name, storefront, playlistId, shareUrl, orderedCatalogIds };
}

export function publicAppleSmokeError(error: unknown): { code: string; message: string; status?: number } {
  if (error instanceof AppleAuthorizationRequiredError) {
    return { code: "apple_reauthorization_required", message: "The owner must reauthorize Apple Music.", status: error.status ?? undefined };
  }
  if (error instanceof ApplePlaylistDivergedError) {
    return { code: "playlist_diverged", message: "The test playlist did not match the requested order." };
  }
  if (error instanceof AppleShareLinkUnavailableError) {
    return { code: "share_link_unavailable", message: "Apple did not expose a stable public playlist link." };
  }
  if (error instanceof AppleApiError) {
    return { code: "apple_api_error", message: "Apple Music rejected or could not complete the test request.", status: error.status ?? undefined };
  }
  if (error instanceof Error && (
    error.message.startsWith("Live Apple writes require")
    || error.message.startsWith("Smoke playlist names")
    || error.message.startsWith("Smoke playlist names cannot")
    || error.message.startsWith("Apple smoke tests require")
    || error.message.startsWith("Apple catalog IDs")
    || error.message.startsWith("Unknown Apple smoke argument")
    || error.message.startsWith("--name requires")
    || error.message.startsWith("--catalog-id requires")
  )) {
    return { code: "invalid_smoke_input", message: error.message };
  }
  return { code: "smoke_failed", message: "The Apple publication smoke test failed without exposing private diagnostics." };
}
