export type GatewayRouteRule = {
  method: "GET" | "POST" | "DELETE";
  path: RegExp;
  owner?: boolean;
};

export const DEFAULT_GATEWAY_BODY_LIMIT = 64 * 1024;
export const BULK_SELECTION_BODY_LIMIT = 1024 * 1024;

export function gatewayBodyLimit(method: string, pathname: string): number {
  return method.toUpperCase() === "POST"
    && /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/selection$/.test(pathname)
    ? BULK_SELECTION_BODY_LIMIT
    : DEFAULT_GATEWAY_BODY_LIMIT;
}

const ROUTE_RULES: readonly GatewayRouteRule[] = [
  { method: "GET", path: /^\/health\/live$/ },
  { method: "POST", path: /^\/api\/v1\/brief$/ },
  { method: "GET", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+$/ },
  { method: "POST", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+\/answers$/ },
  { method: "DELETE", path: /^\/api\/v1\/brief\/[A-Za-z0-9_-]+$/ },
  { method: "POST", path: /^\/api\/v1\/capabilities\/exchange$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/capabilities\/transfer$/ },
  { method: "POST", path: /^\/api\/v1\/runs$/ },
  { method: "GET", path: /^\/api\/v1\/runs$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+$/ },
  { method: "DELETE", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/exceptions$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/tracks$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/matching$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/selection$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/review$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/manifest$/ },
  { method: "POST", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/publish$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/result$/ },
  { method: "GET", path: /^\/api\/v1\/runs\/[A-Za-z0-9_-]+\/evidence$/ },
  { method: "GET", path: /^\/api\/v1\/owner\/(?:status|budgets|runs|apple\/developer-token|apple\/authorization|publications\/orphans)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/(?:emergency-pause|retention\/run|apple\/authorization(?:\/validate)?)$/, owner: true },
  { method: "POST", path: /^\/api\/v1\/owner\/runs\/[A-Za-z0-9_-]+\/(?:refresh|catalog-import|budget)$/, owner: true },
  { method: "DELETE", path: /^\/api\/v1\/owner\/apple\/authorization$/, owner: true },
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
