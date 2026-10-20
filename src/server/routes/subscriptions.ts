import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";
import type { SubFormat } from "../services/subscription-service.js";

const createSchema = z.object({
  clientId: z.string().min(10).max(64),
  name: z.string().trim().min(1).max(80),
  format: z.enum(["xray_uri", "raw_uri", "singbox_json"]).optional(),
  expiresAt: z.union([z.string().datetime({ offset: true }), z.literal(""), z.null()]).optional(),
});

/**
 * Subscription management (admin) + public tokenized fetch.
 * - Public GET /api/sub/:token: rate limited, no auth, no token logging.
 * - Raw tokens are shown once at creation or rotation and stored hashed.
 */
export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/subscriptions", {
    async handler(request, reply) {
      requireAuth(request);
      const query = (request.query ?? {}) as {
        page?: unknown;
        pageSize?: unknown;
        clientId?: unknown;
        includeRevoked?: unknown;
      };
      const q = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
          clientId: z.string().max(64).optional(),
          includeRevoked: z.enum(["true", "false"]).optional(),
        })
        .safeParse(query);
      if (!q.success) return reply.status(400).send({ error: "invalid query" });
      const where: Record<string, unknown> = {};
      if (q.data.clientId) where.clientId = q.data.clientId;
      if (q.data.includeRevoked !== "true") where.revokedAt = null;
      const [rows, total] = await Promise.all([
        fastify.prisma.subscription.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (q.data.page - 1) * q.data.pageSize,
          take: q.data.pageSize,
          include: { client: true },
        }),
        fastify.prisma.subscription.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientLabel: r.client.label,
          name: r.name,
          format: r.format,
          // The token is hashed at rest and cannot be recovered. A new URL is
          // only available once at creation or after explicit rotation.
          url: null,
          tokenHint: r.tokenHint,
          expiresAt: r.expiresAt?.toISOString() ?? null,
          revokedAt: r.revokedAt?.toISOString() ?? null,
          lastAccessAt: r.lastAccessAt?.toISOString() ?? null,
          tokenRotatedAt: r.tokenRotatedAt?.toISOString() ?? null,
          accessCount: r.accessCount,
          createdAt: r.createdAt.toISOString(),
        })),
        page: q.data.page,
        pageSize: q.data.pageSize,
        total,
        maxPerClientNote:
          "The raw subscription URL is shown only once. Store it securely or rotate to reveal a new URL.",
      };
    },
  });

  fastify.post("/api/subscriptions", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid payload",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const result = await fastify.services.subscriptions.create(
        {
          clientId: parsed.data.clientId,
          name: parsed.data.name,
          format: parsed.data.format,
          expiresAt: parsed.data.expiresAt || null,
        },
        request.sessionUser!.id
      );
      if (!result.ok || !result.value) {
        return reply.status(400).send({ error: result.error ?? "could not create subscription" });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "subscription.create",
        targetType: "subscription",
        targetId: result.value.id,
        meta: {
          format: result.value.format,
          tokenHint: result.value.tokenHint,
          clientId: parsed.data.clientId,
        },
        ip: request.ip,
      });
      return reply.status(201).send(result.value);
    },
  });

  fastify.post("/api/subscriptions/:id/rotate", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const result = await fastify.services.subscriptions.rotate(id);
      if (!result.ok || !result.url) {
        return reply.status(404).send({ error: result.error ?? "not found" });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "subscription.rotate",
        targetType: "subscription",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      return { url: result.url };
    },
  });

  fastify.post("/api/subscriptions/:id/revoke", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const result = await fastify.services.subscriptions.revoke(
        id,
        `revoked by ${request.sessionUser!.username}`
      );
      if (!result.ok) return reply.status(404).send({ error: "subscription not found" });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "subscription.revoke",
        targetType: "subscription",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  // ---- Public tokenized fetch -------------------------------------------
  fastify.get("/api/sub/:token", {
    config: { rateLimit: { max: 60, timeWindow: "5 minutes" } },
    async handler(request, reply) {
      const { token } = request.params as { token: string };
      if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) {
        return reply.status(404).send({ error: "not found" });
      }
      const resolved = await fastify.services.subscriptions.resolveByToken(token);
      if (!resolved) return reply.status(404).send({ error: "not found" });
      reply.header("content-type", resolved.contentType);
      reply.header("cache-control", "no-store, no-cache, must-revalidate, private");
      reply.header("pragma", "no-cache");
      reply.header("x-content-type-options", "nosniff");
      reply.header("profile-update-interval", "6");
      reply.header("profile-title", "PanahGozar");
      reply.header("profile-web-page-url", fastify.appConfig.publicUrl);
      return reply.send(resolved.payload);
    },
  });
}

export type { SubFormat };
