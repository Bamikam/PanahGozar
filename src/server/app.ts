import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./env-types.js";
import { loadConfig } from "./env.js";
import { PrismaClient } from "@prisma/client";
import { createDb } from "./db.js";
import { buildLogger } from "./logger.js";
import { AuditService } from "./audit/audit-service.js";
import { ClientService } from "./services/client-service.js";
import { ConfigService } from "./services/config-service.js";
import { SubscriptionService } from "./services/subscription-service.js";
import { StatusService } from "./services/status-service.js";
import { ProtocolRegistry } from "./protocols/registry.js";
import { registerSessionResolver, requireAuth } from "./auth/auth-plugin.js";
import { SessionService } from "./auth/session-service.js";
import { authRoutes } from "./routes/auth.js";
import { setupRoutes } from "./routes/setup.js";
import { systemRoutes } from "./routes/system.js";
import { clientRoutes } from "./routes/clients.js";
import { configurationRoutes } from "./routes/configurations.js";
import { protocolRoutes } from "./routes/protocols.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { settingsRoutes } from "./routes/settings.js";
import { openapiDocument } from "./openapi.js";
import { constantTimeEqual } from "./security/tokens.js";
import "./routes/types.js";

export interface AppServices {
  audit: AuditService;
  clients: ClientService;
  configs: ConfigService;
  subscriptions: SubscriptionService;
  status: StatusService;
}

export interface BuildAppResult {
  app: FastifyInstance;
  cfg: AppConfig;
  db: PrismaClient;
}

/** Public API routes. Everything else under /api requires a session. */
function isPublicApiPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname === "/api/ready" ||
    pathname === "/api/openapi.json" ||
    pathname === "/api/setup/status" ||
    pathname === "/api/setup" ||
    pathname === "/api/auth/login" ||
    pathname.startsWith("/api/docs") ||
    pathname.startsWith("/api/sub/")
  );
}

function safePathname(url: string): string {
  return url.split("?")[0] ?? url;
}

/**
 * Builds the full application: security middleware, services, routes,
 * OpenAPI, and static SPA serving. It performs no startup database queries,
 * so liveness checks and auth rejection remain available while PostgreSQL is
 * unreachable; readiness reports the dependency truthfully.
 */
export async function buildApp(
  opts: { cfg?: AppConfig; db?: PrismaClient } = {}
): Promise<BuildAppResult> {
  const cfg = opts.cfg ?? loadConfig();
  const db = opts.db ?? createDb(cfg);
  const logger = buildLogger(cfg);

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: cfg.trustProxy,
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
  }) as unknown as FastifyInstance;

  const registry = new ProtocolRegistry(db);
  const services: AppServices = {
    audit: new AuditService(db),
    clients: new ClientService(db, cfg, registry),
    configs: new ConfigService(db, cfg, registry),
    subscriptions: new SubscriptionService(db, cfg, registry),
    status: new StatusService(db, registry),
  };

  app.decorate("prisma", db);
  app.decorate("appConfig", cfg);
  app.decorate("services", {
    ...services,
    registry,
    capabilities: makeCapabilities(db, registry),
  });

  // --- Security middleware --------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    hsts: cfg.publicUrl.startsWith("https://")
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
  });

  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });
  await app.register(cors, {
    // Same-origin admin SPA. No cross-origin credential sharing is enabled.
    origin: false,
    credentials: false,
  });

  // --- Sessions & authorization ---------------------------------------------
  const sessionService = new SessionService(db, cfg.cookieSecure);
  registerSessionResolver(app, sessionService);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    // Unknown API paths fall through to the 404 handler without disclosing a
    // session requirement for routes that do not exist.
    if ((request as unknown as { is404?: boolean }).is404) return;
    const pathname = safePathname(request.url);
    if (isPublicApiPath(pathname)) return;

    // Authentication is denied by default for any matched /api route. Routes
    // still call requireRole for authorization; this closes accidental gaps.
    requireAuth(request);

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const header = request.headers["x-csrf-token"];
      if (
        typeof header !== "string" ||
        !constantTimeEqual(header, request.sessionUser!.csrfToken)
      ) {
        return reply.status(403).send({ error: "csrf validation failed", code: "CSRF" });
      }
    }
  });

  // --- Error sanitizer ---------------------------------------------------------
  // Must be installed before route registration so route contexts inherit it.
  app.setErrorHandler((rawError, request, reply) => {
    const err = rawError as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      details?: unknown;
    };
    const rawStatus = err.statusCode ?? 500;
    const statusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;

    if (err.code === "P2002") {
      return reply.status(409).send({ error: "conflict: value already exists", code: "CONFLICT" });
    }
    if (err.code === "P2025") {
      return reply.status(404).send({ error: "not found", code: "NOT_FOUND" });
    }
    if (err.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.status(400).send({ error: "request body is not valid JSON", code: "BAD_JSON" });
    }
    if (err.validation) {
      return reply.status(400).send({ error: "invalid request", code: "VALIDATION" });
    }
    if (statusCode >= 500) {
      request.log.error({ err }, "unhandled error");
      return reply.status(500).send({ error: "internal server error", code: "INTERNAL" });
    }
    if (statusCode === 401) {
      return reply.status(401).send({ error: "authentication required", code: "AUTH_REQUIRED" });
    }
    if (statusCode === 403) {
      return reply.status(403).send({ error: err.message || "forbidden", code: "FORBIDDEN" });
    }
    if (statusCode === 429) {
      return reply.status(429).send({ error: "too many requests", code: "RATE_LIMITED" });
    }
    const details = err.details;
    return reply.status(statusCode).send({
      error: err.message || "bad request",
      ...(details !== undefined ? { details } : {}),
    });
  });

  // --- OpenAPI ---------------------------------------------------------------
  await app.register(swagger, {
    openapi: openapiDocument as never,
    hideUntagged: true,
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });
  app.get("/api/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return openapiDocument;
  });

  // --- Routes -----------------------------------------------------------------
  await app.register(systemRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(clientRoutes);
  await app.register(configurationRoutes);
  await app.register(protocolRoutes);
  await app.register(subscriptionRoutes);
  await app.register(settingsRoutes);

  // --- Error sanitizer is installed above (before routes) ---------------------

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.status(404).send({ error: "not found", code: "NOT_FOUND" });
    }
    const webRoot = path.resolve(process.cwd(), "dist/web");
    if (existsSync(path.join(webRoot, "index.html"))) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply
      .status(503)
      .type("text/plain")
      .send(
        cfg.nodeEnv === "development"
          ? "Frontend dev server is not running. Use Vite at http://localhost:5173."
          : "Frontend build is missing. Run `pnpm build`."
      );
  });

  // --- SPA static serving (production build) -----------------------------------
  const webRoot = path.resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, {
      root: webRoot,
      prefix: "/",
      index: false,
      wildcard: false,
      maxAge: "1h",
      setHeaders(reply, filePath) {
        if (filePath.endsWith("index.html")) {
          reply.header("cache-control", "no-store");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header("cache-control", "public, max-age=31536000, immutable");
        }
      },
    });
  }

  return { app, cfg, db };
}

function makeCapabilities(db: PrismaClient, registry: ProtocolRegistry) {
  return {
    async factorize() {
      const { collectEnvironmentFacts } = await import("./capabilities/runtime-detector.js");
      return collectEnvironmentFacts();
    },
    async sweep() {
      const { collectEnvironmentFacts, runCapabilitySweep } =
        await import("./capabilities/runtime-detector.js");
      const facts = await collectEnvironmentFacts();
      return runCapabilitySweep(
        db,
        facts,
        registry.list().map((adapter) => adapter.id)
      );
    },
    async migrationsApplied(): Promise<boolean> {
      try {
        const rows = (await db.$queryRawUnsafe(
          `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL LIMIT 1`
        )) as unknown[];
        return rows.length > 0;
      } catch {
        return false;
      }
    },
  };
}
