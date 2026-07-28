import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  capabilityHash,
  capabilityVerificationHashes,
  HttpError,
  randomToken,
} from "./security.ts";

export const CAPABILITY_COOKIE = process.env.NODE_ENV === "production" ? "__Host-needle-session" : "needle-session";

export interface CapabilitySessionView {
  id: string;
  runId: string | null;
  accessId: string | null;
  expiresAt: Date;
}

export interface RunCapabilitySessionView extends CapabilitySessionView {
  runId: string;
  accessId: string;
}

export interface CapabilityRepository {
  createCapabilityToken(runId: string, accessId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  attachCapabilitySessionToBrief(briefRequestId: string, session: {
    id: string;
    tokenHash?: string;
    expiresAt?: Date;
    reuseExisting?: boolean;
  }): Promise<CapabilitySessionView | null>;
  exchangeCapabilityToken(tokenHashes: readonly string[], session: {
    id: string;
    tokenHash?: string;
    expiresAt?: Date;
    reuseExisting?: boolean;
  }): Promise<CapabilitySessionView | null>;
  getCapabilitySession(tokenHashes: readonly string[]): Promise<CapabilitySessionView | null>;
  getCapabilitySessionAccess(sessionId: string, accessId: string): Promise<{ runId: string; accessId: string } | null>;
  getCapabilitySessionBrief(sessionId: string, briefRequestId: string): Promise<boolean>;
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

  async authorizeBrief(
    request: FastifyRequest,
    reply: FastifyReply,
    briefRequestId: string,
  ): Promise<CapabilitySessionView> {
    const existingSession = await this.authenticateOptional(request);
    const sessionToken = existingSession ? null : randomToken();
    const expiresAt = existingSession
      ? existingSession.expiresAt
      : new Date(Date.now() + Number(process.env.CAPABILITY_SESSION_TTL_DAYS ?? 90) * 86_400_000);
    const session = await this.repository.attachCapabilitySessionToBrief(
      briefRequestId,
      existingSession
        ? { id: existingSession.id, reuseExisting: true }
        : {
            id: randomUUID(),
            tokenHash: capabilityHash(sessionToken!),
            expiresAt,
          },
    );
    if (!session) throw new HttpError(404, "Brief request not found", "brief_not_found");
    if (sessionToken) {
      reply.header("Set-Cookie", `${CAPABILITY_COOKIE}=${sessionToken}; ${cookieAttributes(expiresAt)}`);
    }
    reply.header("Cache-Control", "no-store");
    return session;
  }

  async issue(runId: string, accessId: string, ttlMs = 30 * 60_000): Promise<string> {
    const token = randomToken();
    await this.repository.createCapabilityToken(runId, accessId, capabilityHash(token), new Date(Date.now() + ttlMs));
    return token;
  }

  async exchange(
    token: string,
    reply: FastifyReply,
    existingSession: CapabilitySessionView | null = null,
  ): Promise<RunCapabilitySessionView> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(400, "Capability token is invalid", "invalid_capability");
    const sessionToken = existingSession ? null : randomToken();
    const expiresAt = existingSession
      ? existingSession.expiresAt
      : new Date(Date.now() + Number(process.env.CAPABILITY_SESSION_TTL_DAYS ?? 90) * 86_400_000);
    const session = await this.repository.exchangeCapabilityToken(
      capabilityVerificationHashes(token),
      existingSession
        ? { id: existingSession.id, reuseExisting: true }
        : { id: randomUUID(), tokenHash: capabilityHash(sessionToken!), expiresAt },
    );
    if (!session) throw new HttpError(401, "Capability token is invalid or expired", "invalid_capability");
    if (!session.runId || !session.accessId) {
      throw new HttpError(401, "Capability token is invalid or expired", "invalid_capability");
    }
    if (sessionToken) reply.header("Set-Cookie", `${CAPABILITY_COOKIE}=${sessionToken}; ${cookieAttributes(expiresAt)}`);
    reply.header("Cache-Control", "no-store");
    return {
      ...session,
      runId: session.runId,
      accessId: session.accessId,
    };
  }

  async authenticateOptional(request: FastifyRequest): Promise<CapabilitySessionView | null> {
    const token = getCookie(request, CAPABILITY_COOKIE);
    if (!token) return null;
    return this.repository.getCapabilitySession(capabilityVerificationHashes(token));
  }

  async authenticate(request: FastifyRequest): Promise<CapabilitySessionView> {
    const session = await this.authenticateOptional(request);
    if (!session) throw new HttpError(401, "Session has expired", "capability_required");
    return session;
  }

  async authenticateForAccess(request: FastifyRequest, accessId: string): Promise<RunCapabilitySessionView> {
    const session = await this.authenticate(request);
    const mapping = await this.repository.getCapabilitySessionAccess(session.id, accessId);
    if (!mapping) {
      throw new HttpError(403, "This session cannot access that run", "capability_scope_mismatch");
    }
    return { ...session, ...mapping };
  }

  async authenticateForBrief(request: FastifyRequest, briefRequestId: string): Promise<CapabilitySessionView> {
    const session = await this.authenticate(request);
    if (!await this.repository.getCapabilitySessionBrief(session.id, briefRequestId)) {
      // Do not reveal whether an unscoped UUID exists.
      throw new HttpError(404, "Brief request not found", "brief_not_found");
    }
    return session;
  }

  async revoke(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = getCookie(request, CAPABILITY_COOKIE);
    if (token) {
      const session = await this.repository.getCapabilitySession(
        capabilityVerificationHashes(token),
      );
      if (session) await this.repository.revokeCapabilitySession(session.id);
    }
    reply.header("Set-Cookie", `${CAPABILITY_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  }
}
