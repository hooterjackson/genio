/** Cloudflare Sites entry point and the only browser-to-Railway gateway. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  DEFAULT_GATEWAY_BODY_LIMIT,
  forwardedCapabilityCookie,
  gatewayBodyLimit,
  isCrossSiteMutation,
  matchGatewayRoute,
} from "./gateway-policy.ts";

interface Env {
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  RAILWAY_API_BASE?: string;
  GATEWAY_KEY_ID?: string;
  GATEWAY_HMAC_SECRET?: string;
  GATEWAY_PREVIOUS_KEY_ID?: string;
  GATEWAY_PREVIOUS_HMAC_SECRET?: string;
  IP_HASH_SECRET?: string;
  OWNER_EMAIL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Sites and Miniflare always supply Worker bindings. Vinext's production Node
 * preview currently omits that argument, so the local QA launcher explicitly
 * opts into the narrow process-variable fallback. Without that opt-in, fail
 * closed: a mistakenly exposed Node preview must not trust a browser-supplied
 * owner header and sign it with real gateway credentials from process.env.
 */
function localPreviewEnvironment(environment: Env | undefined): Env {
  if (environment) return environment;
  const variables = typeof process === "undefined" ? {} : process.env;
  if (variables.GENIO_QA_LOCAL_PREVIEW !== "1") return {} as Env;
  return {
    RAILWAY_API_BASE: variables.RAILWAY_API_BASE,
    GATEWAY_KEY_ID: variables.GATEWAY_KEY_ID,
    GATEWAY_HMAC_SECRET: variables.GATEWAY_HMAC_SECRET,
    GATEWAY_PREVIOUS_KEY_ID: variables.GATEWAY_PREVIOUS_KEY_ID,
    GATEWAY_PREVIOUS_HMAC_SECRET: variables.GATEWAY_PREVIOUS_HMAC_SECRET,
    IP_HASH_SECRET: variables.IP_HASH_SECRET,
    OWNER_EMAIL: variables.OWNER_EMAIL,
  } as Env;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function dateInSaoPaulo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

async function clientBuckets(request: Request, pepper: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || "unavailable";
  const now = new Date();
  const previous = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const currentDate = dateInSaoPaulo(now);
  const previousDate = dateInSaoPaulo(previous);
  const current = await hmacBase64Url(pepper, currentDate + "\n" + ip);
  const prior = await hmacBase64Url(pepper, previousDate + "\n" + ip);
  return currentDate + "." + current + "|" + previousDate + "." + prior;
}

async function readLimitedBody(request: Request, limit = DEFAULT_GATEWAY_BODY_LIMIT): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("request body too large");
        throw new RangeError("request body exceeds the route limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function nonce(): string {
  const value = new Uint8Array(18);
  crypto.getRandomValues(value);
  return base64Url(value);
}

function normalizeOwnerEmail(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function safeResponse(response: Response, isApi = false, isLocal = false): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  // MusicKit's web authorization popup needs the page origin as cross-origin
  // referrer context. Keep API responses maximally restrictive, while sending
  // only the origin (never the path) from HTML pages to Apple.
  headers.set("Referrer-Policy", isApi ? "no-referrer" : "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; " +
      "script-src 'self' 'unsafe-inline' https://js-cdn.music.apple.com" + (isLocal ? " 'unsafe-eval'" : "") + "; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
      "connect-src 'self' https://api.music.apple.com https://*.music.apple.com" +
      (isLocal ? " ws://localhost:* ws://127.0.0.1:*" : "") + "; " +
      "frame-src https://music.apple.com https://*.apple.com",
  );
  if (isApi) headers.set("Cache-Control", "no-store");
  if (!isLocal) headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readLimitedResponse(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body.cancel("upstream response too large");
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("upstream response too large");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function gateway(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const rule = matchGatewayRoute(method, url.pathname);
  if (!rule) return jsonError(404, "Gateway route not found.");
  const requestBodyLimit = gatewayBodyLimit(method, url.pathname);

  if (isCrossSiteMutation({
    method,
    origin: request.headers.get("origin"),
    expectedOrigin: url.origin,
    fetchSite: request.headers.get("sec-fetch-site"),
  })) {
    return jsonError(403, "Cross-site mutation rejected.");
  }

  if ((method === "GET" || method === "DELETE") && request.body) {
    return jsonError(400, method + " requests cannot include a body.");
  }

  const expectedOwner = normalizeOwnerEmail(env.OWNER_EMAIL ?? null);
  const authenticatedEmail = normalizeOwnerEmail(request.headers.get("oai-authenticated-user-email"));
  const ownerEmail = expectedOwner && authenticatedEmail === expectedOwner ? authenticatedEmail : "";
  if (rule.owner) {
    if (!expectedOwner) return jsonError(503, "Owner allowlist is not configured.");
    if (!authenticatedEmail) return jsonError(401, "ChatGPT owner authentication required.");
    if (authenticatedEmail !== expectedOwner) return jsonError(403, "Owner access denied.");
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const backendBase = env.RAILWAY_API_BASE || (isLocal ? "http://127.0.0.1:8788" : "");
  const hasCurrentKey = Boolean(env.GATEWAY_KEY_ID);
  const hasCurrentSecret = Boolean(env.GATEWAY_HMAC_SECRET);
  const hasPreviousKey = Boolean(env.GATEWAY_PREVIOUS_KEY_ID);
  const hasPreviousSecret = Boolean(env.GATEWAY_PREVIOUS_HMAC_SECRET);
  if (hasCurrentKey !== hasCurrentSecret || hasPreviousKey !== hasPreviousSecret) {
    return jsonError(503, "Gateway key rotation pairs are incomplete.");
  }
  const keyId = hasCurrentKey
    ? env.GATEWAY_KEY_ID!
    : hasPreviousKey
      ? env.GATEWAY_PREVIOUS_KEY_ID!
      : isLocal
        ? "local-dev"
        : "";
  const secret = hasCurrentSecret
    ? env.GATEWAY_HMAC_SECRET!
    : hasPreviousSecret
      ? env.GATEWAY_PREVIOUS_HMAC_SECRET!
      : isLocal
        ? "needle-local-development-only"
        : "";
  const pepper = env.IP_HASH_SECRET || (isLocal ? "needle-local-ip-pepper" : "");
  if (!backendBase || !keyId || !secret || !pepper) {
    return jsonError(503, "Hosted gateway is not configured.");
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || (!isLocal && (secret.length < 24 || pepper.length < 24))) {
    return jsonError(503, "Hosted gateway secrets are invalid.");
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > requestBodyLimit) {
    return jsonError(413, "Request body exceeds the route limit.");
  }

  let body: Uint8Array;
  try {
    body = await readLimitedBody(request, requestBodyLimit);
  } catch (caught) {
    if (caught instanceof RangeError) return jsonError(413, caught.message);
    return jsonError(400, "Could not read request body.");
  }

  const contentType = request.headers.get("content-type");
  if (body.byteLength > 0 && (!contentType || !contentType.toLowerCase().startsWith("application/json"))) {
    return jsonError(415, "Gateway accepts JSON request bodies only.");
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestNonce = nonce();
  const bodyHash = await sha256Hex(body);
  const buckets = await clientBuckets(request, pepper);
  const signedPath = url.pathname + url.search;
  const canonical = [
    keyId,
    timestamp,
    requestNonce,
    method,
    signedPath,
    bodyHash,
    buckets,
    ownerEmail,
  ].join("\n");
  const signature = await hmacBase64Url(secret, canonical);

  let upstreamBase: URL;
  try {
    upstreamBase = new URL(backendBase);
  } catch {
    return jsonError(503, "Hosted gateway target is invalid.");
  }
  if (!isLocal && upstreamBase.protocol !== "https:") {
    return jsonError(503, "Hosted gateway requires HTTPS.");
  }
  const upstream = new URL(signedPath, upstreamBase);
  const headers = new Headers({
    "Accept": "application/json",
    "X-Needle-Key-Id": keyId,
    "X-Needle-Timestamp": timestamp,
    "X-Needle-Nonce": requestNonce,
    "X-Needle-Body-Sha256": bodyHash,
    "X-Needle-Client-Bucket": buckets,
    "X-Needle-Signature": signature,
  });
  if (ownerEmail) headers.set("X-Needle-Owner-Email", ownerEmail);

  let cookie: string | null;
  try {
    cookie = forwardedCapabilityCookie(request.headers.get("cookie"), !isLocal);
  } catch (caught) {
    return jsonError(400, caught instanceof Error ? caught.message : "gênio capability cookie is invalid.");
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (contentType && body.byteLength > 0) headers.set("Content-Type", contentType);
  if (cookie) headers.set("Cookie", cookie);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  let response: Response;
  try {
    response = await fetch(upstream, {
      method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
      redirect: "manual",
    });
  } catch {
    return jsonError(502, "gênio is temporarily unavailable.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel("upstream redirects are not allowed");
    return jsonError(502, "gênio returned an unexpected redirect.");
  }

  const responseBody = await readLimitedResponse(response);
  if (responseBody === null) return jsonError(502, "gênio returned an oversized response.");
  const responseHeaders = new Headers(response.headers);
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "server",
    "x-powered-by",
  ]) {
    responseHeaders.delete(name);
  }
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

const worker = {
  async fetch(request: Request, suppliedEnvironment: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const env = localPreviewEnvironment(suppliedEnvironment);
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return safeResponse(response, false, url.hostname === "localhost" || url.hostname === "127.0.0.1");
    }

    if (url.pathname.startsWith("/api/v1/") || url.pathname === "/health/live") {
      return safeResponse(
        await gateway(request, env, url),
        true,
        url.hostname === "localhost" || url.hostname === "127.0.0.1",
      );
    }

    if (url.pathname === "/owner" || url.pathname.startsWith("/owner/")) {
      const expectedOwner = normalizeOwnerEmail(env.OWNER_EMAIL ?? null);
      const authenticatedEmail = normalizeOwnerEmail(request.headers.get("oai-authenticated-user-email"));
      const ownerHeaders = new Headers(request.headers);
      ownerHeaders.delete("x-needle-owner-verified");
      if (!expectedOwner) {
        return safeResponse(new Response("Owner allowlist is not configured.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        }), false, url.hostname === "localhost" || url.hostname === "127.0.0.1");
      }
      if (expectedOwner && authenticatedEmail && authenticatedEmail !== expectedOwner) {
        return safeResponse(new Response("Owner access denied.", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        }), false, url.hostname === "localhost" || url.hostname === "127.0.0.1");
      }
      if (authenticatedEmail === expectedOwner) {
        ownerHeaders.set("x-needle-owner-verified", "1");
      }
      return safeResponse(
        await handler.fetch(new Request(request, { headers: ownerHeaders }), env, ctx),
        false,
        url.hostname === "localhost" || url.hostname === "127.0.0.1",
      );
    }

    return safeResponse(
      await handler.fetch(request, env, ctx),
      false,
      url.hostname === "localhost" || url.hostname === "127.0.0.1",
    );
  },
};

export default worker;
