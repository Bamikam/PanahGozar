import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionService } from "./session-service.js";
import { constantTimeEqual } from "../security/tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    sessionService: SessionService;
  }
  interface FastifyRequest {
    sessionUser: {
      id: string;
      username: string;
      roleName: "admin" | "operator" | "viewer";
      csrfToken: string;
    } | null;
  }
}

type HttpError = Error & { statusCode?: number; code?: string };

function httpError(message: string, statusCode: number, code: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Installs the session service and resolves `request.sessionUser` for every
 * /api request. Routes additionally make their role requirements explicit.
 */
export function registerSessionResolver(fastify: FastifyInstance, service: SessionService) {
  fastify.decorate("sessionService", service);
  fastify.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api")) return;
    request.sessionUser = await service.readSession(request);
  });
}

export function requireAuth(request: FastifyRequest): void {
  if (!request.sessionUser) {
    throw httpError("authentication required", 401, "AUTH_REQUIRED");
  }
}

export type RoleName = "admin" | "operator" | "viewer";

const ROLE_RANK: Record<RoleName, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** The session user must hold at least `minRole`. */
export function requireRole(request: FastifyRequest, minRole: RoleName): void {
  requireAuth(request);
  const user = request.sessionUser!;
  if (ROLE_RANK[user.roleName] < ROLE_RANK[minRole]) {
    throw httpError("insufficient role", 403, "FORBIDDEN");
  }
}

/** CSRF double-submit check for state-changing requests. */
export function requireCsrf(request: FastifyRequest): void {
  const user = request.sessionUser;
  if (!user) {
    throw httpError("authentication required", 401, "AUTH_REQUIRED");
  }
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const header = request.headers["x-csrf-token"];
  if (typeof header !== "string" || !constantTimeEqual(header, user.csrfToken)) {
    throw httpError("csrf validation failed", 403, "CSRF");
  }
}
