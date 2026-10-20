import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  generateSessionToken,
  generateUuid,
  sha256,
  constantTimeEqual,
} from "../security/tokens.js";

// Support package.json "type": "module" resolution (.js suffix on relative imports
// is required by NodeNext module resolution for runtime ESM).

export const SESSION_COOKIE = "pg_session";
export const CSRF_COOKIE = "pg_csrf";
export const CSRF_HEADER = "x-csrf-token";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const SESSION_IDLE_MS = 60 * 60 * 1000; // refresh after 1h idle

export interface SessionUser {
  id: string;
  username: string;
  roleName: "admin" | "operator" | "viewer";
  csrfToken: string;
}

export class SessionService {
  constructor(
    private db: PrismaClient,
    private cookieSecure: boolean
  ) {}

  async createSession(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string
  ): Promise<SessionUser> {
    const token = generateSessionToken();
    const csrfToken = generateUuid();
    await this.db.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        csrfToken,
        ip: request.ip ?? null,
        userAgent: (request.headers["user-agent"] as string | undefined)?.slice(0, 250) ?? null,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    this.setCookie(reply, token);
    reply.setCookie(CSRF_COOKIE, csrfToken, {
      path: "/",
      httpOnly: false, // double-submit token must be readable by the SPA
      sameSite: "strict",
      secure: this.cookieSecure,
      maxAge: SESSION_TTL_MS / 1000,
    });
    const user = await this.db.adminUser.findUniqueOrThrow({
      where: { id: userId },
      include: { role: true },
    });
    return {
      id: user.id,
      username: user.username,
      roleName: user.role.name,
      csrfToken,
    };
  }

  private setCookie(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: this.cookieSecure,
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  async readSession(request: FastifyRequest): Promise<SessionUser | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = await this.db.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: true } } },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() < Date.now()) {
      await this.revokeByTokenHash(tokenHash, "expired").catch(() => {});
      return null;
    }
    if (!session.user.isActive || session.user.deletedAt) return null;
    await this.postponeExpiry(session.id, session.lastSeenAt.getTime());
    return {
      id: session.user.id,
      username: session.user.username,
      roleName: session.user.role.name,
      csrfToken: session.csrfToken,
    };
  }

  private postponeExpiry(id: string, lastSeenMs: number) {
    if (Date.now() - lastSeenMs < SESSION_IDLE_MS) return Promise.resolve();
    return this.db.session.update({
      where: { id },
      data: {
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
  }

  async revokeById(id: string, reason: string) {
    await this.db.session
      .update({ where: { id }, data: { revokedAt: new Date(), revokedReason: reason } })
      .catch(() => {});
  }

  async revokeByTokenHash(tokenHash: string, reason: string) {
    await this.db.session
      .update({ where: { tokenHash }, data: { revokedAt: new Date(), revokedReason: reason } })
      .catch(() => {});
  }

  /** Revoke every session of a user — used after login supra-privilege changes. */
  async revokeAllForUser(userId: string, reason: string) {
    await this.db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async clearCookie(reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
  }

  /** CSRF double-submit check for state-changing (non-GET) requests. */
  static assertCsrf(request: FastifyRequest, session: SessionUser): boolean {
    const header = request.headers[CSRF_HEADER];
    if (typeof header !== "string" || header.length === 0) return false;
    return constantTimeEqual(header, session.csrfToken);
  }
}
