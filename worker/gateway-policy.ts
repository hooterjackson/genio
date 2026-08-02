export type GatewayRouteRule = {
  method: "GET" | "POST" | "DELETE";
  path: RegExp;
  owner?: boolean;
};

export const DEFAULT_GATEWAY_BODY_LIMIT = 64 * 1024;
export const BULK_SELECTION_BODY_LIMIT = 1024 * 1024;
export const FEEDBACK_GATEWAY_BODY_LIMIT = 2 * 1024 * 1024;

export function gatewayBodyLimit(method: string, pathname: string): number {
  if (method.toUpperCase() !== "POST") return DEFAULT_GATEWAY_BODY_LIMIT;
  if (/^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/selection$/.test(pathname)) return BULK_SELECTION_BODY_LIMIT;
  if (pathname === "/api/v1/feedback") return FEEDBACK_GATEWAY_BODY_LIMIT;
  return DEFAULT_GATEWAY_BODY_LIMIT;
}

const ROUTE_RULES: readonly GatewayRouteRule[] = [
  { method: "GET", path: /^\/health\/live$/ },
  { method: "GET", path: /^\/health\/ready$/ },
  { method: "GET", path: /^\/health\/system$/ },
  { method: "POST", path: /^\/api\/v1\/feedback$/ },
  { method: "POST", path: /^\/api\/v1\/brief$/ },
  { method: "GET", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+$/ },
  { method: "POST", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+\/answers$/ },
  { method: "DELETE", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+$/ },
  { method: "POST", path: /^\/api\/v1\/capabilities\/exchange$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/capabilities\/transfer$/ },
  { method: "POST", path: /^\/api\/v1\/runs$/ },
  { method: "GET", path: /^\/api\/v1\/playlists$/ },
  { method: "GET", path: /^\/api\/v1\/runs$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+$/ },
  { method: "DELETE", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/progress$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/research\/continue$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/dependency\/resume$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/replay-after-repair$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/partial\/confirm$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/cancel$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/explore$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/exceptions$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/tracks$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/matching$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/selection$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/review$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/manifest$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/publish$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/result$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/evidence$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/manifest-canary-evidence$/ },
  { method: "GET", path: /^\/api\/v1\/owner\/(?:status|budgets|runs|apple\/developer-token|apple\/authorization|publications\/orphans)$/, owner: true },
  { method: "GET", path: /^\/api\/v1\/owner\/feedback$/, owner: true },
  { method: "GET", path: /^\/api\/v1\/owner\/feedback\/[A-Za-z0-9_-]+\/image$/, owner: true },
  { method: "GET", path: /^\/api\/v1\/owner\/corpus\/(?:review|sources|assertions|snapshots)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/(?:emergency-pause|retention\/run|apple\/authorization(?:\/validate)?)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/feedback\/[A-Za-z0-9_-]+\/status$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/playlists\/[A-Za-z0-9_-]+\/visibility$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/playlists\/bulk-hide$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/corpus\/observations(?:\/promote)?$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/corpus\/observations\/[A-Za-z0-9_-]+\/reject$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/corpus\/sources\/[A-Za-z0-9_-]+\/(?:approve|takedown)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/corpus\/assertions\/[A-Za-z0-9_-]+\/(?:dispute|retract)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/corpus\/snapshots$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/runs\/[A-Za-z0-9_-]+\/(?:refresh|catalog-import|budget)$/, owner: true },
  { method: "DELETE", path: /^\/api\/v1\/owner\/apple\/authorization$/, owner: true },
  { method: "DELETE", path: /^\/api\/v1\/owner\/feedback\/[A-Za-z0-9_-]+$/, owner: true },
];

export function matchGatewayRoute(method: string, pathname: string): GatewayRouteRule | null {
  const normalized = method.toUpperCase();
  return ROUTE_RULES.find((rule) => rule.method === normalized && rule.path.test(pathname)) ?? null;
}

export function isCrossSiteMutation(input: {
  method: string;
  origin: string | null;
  expectedOrigin: string;
  fetchSite: string | null;
}): boolean {
  if (!['POST', 'DELETE'].includes(input.method.toUpperCase())) return false;
  return Boolean((input.origin && input.origin !== input.expectedOrigin) || input.fetchSite === "cross-site");
}

export function forwardedCapabilityCookie(cookieHeader: string | null, production: boolean): string | null {
  if (!cookieHeader) return null;
  const expectedName = production ? "__Host-needle-session" : "needle-session";
  const matches = cookieHeader.split(";").flatMap((part) => {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return [];
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name !== expectedName) return [];
    if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("gênio capability cookie is invalid");
    return [`${expectedName}=${value}`];
  });
  if (matches.length > 1) throw new Error("Duplicate gênio capability cookies are not allowed");
  return matches[0] ?? null;
}

/**
 * A production-style local QA preview runs over HTTP while its hosted staging
 * API correctly uses a Secure __Host- cookie. Bridge only the already-filtered
 * gênio capability cookie; no unrelated browser cookie may cross upstream.
 */
export function localQaCapabilityCookieToHosted(
  cookie: string | null,
): string | null {
  if (!cookie) return null;
  if (!cookie.startsWith("needle-session=")) {
    throw new Error("Local QA capability cookie has an unexpected name");
  }
  return `__Host-needle-session=${cookie.slice("needle-session=".length)}`;
}

/**
 * Translate the hosted capability response back to the localhost-only cookie
 * understood by an HTTP QA preview. Production Sites never calls this bridge.
 */
export function hostedCapabilitySetCookieToLocalQa(
  setCookie: string | null,
): string | null {
  if (!setCookie) return null;
  if (!setCookie.startsWith("__Host-needle-session=")) return setCookie;
  return setCookie
    .replace(/^__Host-needle-session=/u, "needle-session=")
    .replace(/;\s*Secure(?=;|$)/giu, "");
}
