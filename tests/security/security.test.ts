/**
 * Security tests - no PostgreSQL required. A minimal Prisma-shaped stub
 * supports the login/audit path while routes that need no database exercise
 * authentication, CSRF-less public boundaries, header policy, rate limiting,
 * 404 masking, and error sanitization.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

const SECRET_MARKER = "DO-NOT-LEAK-INTERNAL-DETAIL";

const prismaStub = {
  adminUser: {
    findUnique: async () => null,
    count: async () => 0,
  },
  auditEvent: {
    create: async () => ({}),
  },
  subscription: {
    findUnique: async () => {
      throw new Error(`database exploded: ${SECRET_MARKER} postgresql://user:pass@host/db`);
    },
  },
} as unknown as PrismaClient;

describe("security behaviors", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "test-session-secret-please-ignore-32chars";
    process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";
    process.env.DATABASE_URL = "postgresql://stub:stub@127.0.0.1:1/stub?schema=public";
    process.env.PUBLIC_URL = "http://localhost:3000";
    process.env.LOG_LEVEL = "error";
    process.env.SETUP_TOKEN = "test-setup-token-at-least-16";

    const { buildApp } = await import("../../src/server/app.js");
    const { loadConfig } = await import("../../src/server/env.js");
    const built = await buildApp({ cfg: loadConfig(), db: prismaStub });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects unauthenticated admin endpoints with a stable error shape", async () => {
    for (const url of [
      "/api/clients",
      "/api/configurations",
      "/api/subscriptions",
      "/api/diagnostics",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });

  it("sets defensive HTTP headers and no permissive CORS", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("masks unknown API routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/not-a-real-endpoint" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("not found");
  });

  it("rejects malformed JSON without a stack trace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("node_modules");
  });

  it("rejects malformed and missing subscription tokens", async () => {
    for (const url of ["/api/sub/", "/api/sub/../etc-passwd", "/api/sub/x"]) {
      const response = await app.inject({ method: "GET", url });
      expect([400, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain("postgres");
    }
  });

  it("sanitizes unexpected server errors", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sub/valid-shape-token-1234567890",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal server error", code: "INTERNAL" });
    expect(response.body).not.toContain(SECRET_MARKER);
    expect(response.body).not.toContain("postgresql://");
  });

  it("rate limits repeated login attempts", async () => {
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": "198.51.100.10" },
        payload: { username: `unknown-${i}`, password: "not-the-password" },
      });
      results.push(response.statusCode);
    }
    expect(results.includes(429)).toBe(true);
    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.10" },
      payload: { username: "another", password: "not-the-password" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not expose application stack traces on client errors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: 123, password: 456 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("at ");
  });
});
