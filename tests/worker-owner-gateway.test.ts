import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vinext/server/image-optimization", () => ({
  DEFAULT_DEVICE_SIZES: [],
  DEFAULT_IMAGE_SIZES: [],
  handleImageOptimization: vi.fn(),
}));

vi.mock("vinext/server/app-router-entry", () => ({
  default: { fetch: vi.fn() },
}));

const appRouterModule = await import("vinext/server/app-router-entry");
const appHandlerFetch = vi.mocked(appRouterModule.default.fetch);

const workerModule = await import("../worker/" + "index.ts") as {
  default: {
    fetch(request: Request, env: unknown, context: unknown): Promise<Response>;
  };
};
const worker = workerModule.default;

const env = {
  RAILWAY_API_BASE: "https://railway.example",
  GATEWAY_KEY_ID: "owner-test-v1",
  GATEWAY_HMAC_SECRET: "owner-test-gateway-secret-at-least-32-bytes",
  IP_HASH_SECRET: "owner-test-ip-secret-at-least-32-bytes",
  OWNER_EMAIL: "owner@example.com",
  OWNER_ALLOWLIST_VERSION: "owner-allowlist-v1",
};

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

function apiRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://needle.example${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://needle.example",
      "Sec-Fetch-Site": "same-origin",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers,
    },
    body: "{}",
  });
}

describe("Sites owner gateway boundary", () => {
  const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  function forwardedHeaders(): Headers {
    return new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
  }

  beforeEach(() => {
    upstreamFetch.mockClear();
    appHandlerFetch.mockReset();
    appHandlerFetch.mockResolvedValue(new Response("<!doctype html><title>gênio</title>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", upstreamFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("an exact allowlisted Sites identity is signed into owner API requests", async () => {
    const request = new Request("https://needle.example/api/v1/owner/apple/authorization", {
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "OAI-Authenticated-User-Email": "OWNER@EXAMPLE.COM",
      },
    });

    const response = await worker.fetch(request, env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(forwardedHeaders().get("x-needle-owner-email")).toBe("owner@example.com");
    expect(forwardedHeaders().get("x-needle-signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-genio-owner-allowlist-version"))
      .toBe("owner-allowlist-v1");
  });

  test("a Node preview without the explicit local-QA opt-in cannot consume process gateway secrets", async () => {
    const names = [
      "GENIO_QA_LOCAL_PREVIEW",
      "RAILWAY_API_BASE",
      "GATEWAY_KEY_ID",
      "GATEWAY_HMAC_SECRET",
      "IP_HASH_SECRET",
      "OWNER_EMAIL",
      "OWNER_ALLOWLIST_VERSION",
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      delete process.env.GENIO_QA_LOCAL_PREVIEW;
      process.env.RAILWAY_API_BASE = env.RAILWAY_API_BASE;
      process.env.GATEWAY_KEY_ID = env.GATEWAY_KEY_ID;
      process.env.GATEWAY_HMAC_SECRET = env.GATEWAY_HMAC_SECRET;
      process.env.IP_HASH_SECRET = env.IP_HASH_SECRET;
      process.env.OWNER_EMAIL = env.OWNER_EMAIL;
      process.env.OWNER_ALLOWLIST_VERSION = env.OWNER_ALLOWLIST_VERSION;

      const response = await worker.fetch(apiRequest("/api/v1/owner/apple/authorization/validate", {
        "OAI-Authenticated-User-Email": "owner@example.com",
      }), undefined, ctx);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Owner allowlist is not configured." });
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("fails closed when an owner allowlist has no explicit release version", async () => {
    const missingVersion = { ...env, OWNER_ALLOWLIST_VERSION: undefined };
    const response = await worker.fetch(
      apiRequest("/api/v1/owner/apple/authorization/validate", {
        "OAI-Authenticated-User-Email": "owner@example.com",
      }),
      missingVersion as never,
      ctx,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Owner allowlist release identity is not configured.",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  test("the owner can retry the saved Apple authorization through the signed gateway", async () => {
    const response = await worker.fetch(apiRequest("/api/v1/owner/apple/authorization/validate", {
      "OAI-Authenticated-User-Email": "owner@example.com",
    }), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(forwardedHeaders().get("x-needle-owner-email")).toBe("owner@example.com");
  });

  test("owner HTML sends origin-only referrer context required by MusicKit authorization", async () => {
    const response = await worker.fetch(new Request("https://needle.example/owner", {
      headers: { "OAI-Authenticated-User-Email": "owner@example.com" },
    }), env as never, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(appHandlerFetch).toHaveBeenCalledOnce();
  });

  test("an exact allowlisted Sites identity is signed into public API requests", async () => {
    const response = await worker.fetch(apiRequest("/api/v1/runs", {
      "OAI-Authenticated-User-Email": "OWNER@EXAMPLE.COM",
    }), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(forwardedHeaders().get("x-needle-owner-email")).toBe("owner@example.com");
    expect(forwardedHeaders().get("x-needle-signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("the paginated public playlist directory crosses the signed gateway without visitor identity", async () => {
    const response = await worker.fetch(new Request(
      "https://needle.example/api/v1/playlists?page=2&pageSize=12",
      { headers: { "CF-Connecting-IP": "203.0.113.10" } },
    ), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
      "https://railway.example/api/v1/playlists?page=2&pageSize=12",
    );
    expect(upstreamFetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(forwardedHeaders().has("x-needle-owner-email")).toBe(false);
    expect(forwardedHeaders().get("x-needle-signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("the release system-health probe crosses the signed gateway with its cache-busting query", async () => {
    const response = await worker.fetch(new Request(
      "https://needle.example/health/system?release-evidence=probe-123",
      { headers: { "CF-Connecting-IP": "203.0.113.10" } },
    ), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
      "https://railway.example/health/system?release-evidence=probe-123",
    );
    expect(upstreamFetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(forwardedHeaders().has("x-needle-owner-email")).toBe(false);
    expect(forwardedHeaders().get("x-needle-signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a different Sites identity remains anonymous on public API requests", async () => {
    const response = await worker.fetch(apiRequest("/api/v1/runs", {
      "OAI-Authenticated-User-Email": "visitor@example.com",
      "X-Needle-Owner-Email": "owner@example.com",
    }), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(forwardedHeaders().has("x-needle-owner-email")).toBe(false);
  });

  test("a browser-supplied owner header cannot cross a public API request", async () => {
    const response = await worker.fetch(apiRequest("/api/v1/runs", {
      "X-Needle-Owner-Email": "owner@example.com",
    }), env as never, ctx);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(forwardedHeaders().has("x-needle-owner-email")).toBe(false);
  });

  test("a non-allowlisted Sites identity cannot reach an owner API", async () => {
    const request = new Request("https://needle.example/api/v1/owner/apple/authorization", {
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "OAI-Authenticated-User-Email": "visitor@example.com",
      },
    });

    const response = await worker.fetch(request, env as never, ctx);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Owner access denied." });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
