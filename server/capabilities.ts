import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { capabilityHash, HttpError, randomToken } from "./security.ts";

export const CAPABILITY_COOKIE = process.env.NODE_ENV === "production" ? "__Host-needle-session" : "needle-session";

export interface CapabilitySessionView {
  id: string;
  runId: string;
  accessId: string;
  expiresAt: Date;
}

export interface CapabilityRepository {
  createCapabilityToken(runId: string, accessId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  exchangeCapabilityToken(tokenHash: string, session: { id: string; tokenHash: string; expiresAt: Date }): Promise<CapabilitySessionView | null>;
  getCapabilitySession(tokenHash: string): Promise<CapabilitySessionView | null>;
  revokeCapabilitySession(sessionId: string): Promise<void>;
}

function cookieAttributes(expiresAt: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict${secure}; Expires=${expiresAt.toUTCString()}`;
}

function getCookie(request: FastifyRequest, name: string): string | null {
  const rawHeaders = request.raw.rawHeaders;
  const cookieHeaders: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "cookie") cookieHeaders.push(rawHeaders[index + 1] ?? "");
  }
  if (cookieHeaders.length > 1) throw new HttpError(400, "Duplicate cookie header", "invalid_session");
  for (const part of (cookieHeaders[0] ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(value)) throw new HttpError(401, "Session is invalid", "invalid_session");
    return value;
  }
  return null;
}

export class CapabilityService {
  constructor(private readonly repository: CapabilityRepository) {}

  async issue(runId: string, accessId: string, ttlMs = 30 * 60_000): Promise<string> {
    const token = randomToken();
    await this.repository.createCapabilityToken(runId, accessId, capabilityHash(token), new Date(Date.now() + ttlMs));
    return token;
  }

  async exchange(token: string, reply: FastifyReply): Promise<CapabilitySessionView> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(400, "Capability token is invalid", "invalid_capability");
    const sessionToken = randomToken();
    const expiresAt = new Date(Date.now() + Number(process.env.CAPABILITY_SESSION_TTL_DAYS ?? 90) * 86_400_000);
    const session = await this.repository.exchangeCapabilityToken(capabilityHash(token), {
      id: randomUUID(),
      tokenHash: capabilityHash(sessionToken),
      expiresAt,
    });
    if (!session) throw new HttpError(401, "Capability token is invalid or expired", "invalid_capability");
    reply.header("Set-Cookie", `${CAPABILITY_COOKIE}=${sessionToken}; ${cookieAttributes(expiresAt)}`);
    reply.header("Cache-Control", "no-store");
    return session;
  }

  async authenticate(request: FastifyRequest): Promise<CapabilitySessionView> {
    const token = getCookie(request, CAPABILITY_COOKIE);
    if (!token) throw new HttpError(401, "Open the private resume link for this run", "capability_required");
    const session = await this.repository.getCapabilitySession(capabilityHash(token));
    if (!session) throw new HttpError(401, "Session has expired", "capability_required");
    return session;
  }

  async authenticateForAccess(request: FastifyRequest, accessId: string): Promise<CapabilitySessionView> {
    const session = await this.authenticate(request);
    if (session.accessId !== accessId) {
      throw new HttpError(403, "This session cannot access that run", "capability_scope_mismatch");
    }
    return session;
  }

  async authenticateOptional(request: FastifyRequest): Promise<CapabilitySessionView | null> {
    const token = getCookie(request, CAPABILITY_COOKIE);
    if (!token) return null;
    return this.repository.getCapabilitySession(capabilityHash(token));
  }

  async revoke(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = getCookie(request, CAPABILITY_COOKIE);
    if (token) {
      const session = await this.repository.getCapabilitySession(capabilityHash(token));
      if (session) await this.repository.revokeCapabilitySession(session.id);
    }
    reply.header("Set-Cookie", `${CAPABILITY_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  }
}
