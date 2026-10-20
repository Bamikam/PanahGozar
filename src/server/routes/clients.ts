import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(160).optional(),
  disabled: z.enum(["true", "false"]).optional(),
  tag: z.string().max(60).optional(),
  orderBy: z.enum(["createdAt", "label", "expiresAt"]).default("createdAt"),
});

function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function safeHeaderFilename(name: string): string {
  return name.replace(/["\r\n\\]/g, "_");
}

/** Clients API - full CRUD, assignments, credential lifecycle, exports, QR. */
export async function clientRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/clients", {
    async handler(request, reply) {
      requireAuth(request);
      const q = pageQuery.safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({
          error: "invalid query",
          details: q.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const disabled = q.data.disabled === undefined ? undefined : q.data.disabled === "true";
      return fastify.services.clients.list({ ...q.data, disabled });
    },
  });

  fastify.get("/api/clients/:id", {
    async handler(request, reply) {
      requireAuth(request);
      const { id } = request.params as { id: string };
      const client = await fastify.services.clients.get(id);
      if (!client) return reply.status(404).send({ error: "not found" });
      return client;
    },
  });

  fastify.post("/api/clients", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const created = await fastify.services.clients.create(request.body ?? {});
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.create",
        targetType: "client",
        targetId: created.id,
        meta: { label: created.label },
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return reply.status(201).send(created);
    },
  });

  fastify.patch("/api/clients/:id", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const updated = await fastify.services.clients.update(id, request.body ?? {});
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.update",
        targetType: "client",
        targetId: id,
        meta: { fields: Object.keys((request.body as object) ?? {}) },
        ip: request.ip,
      });
      return updated;
    },
  });

  fastify.post("/api/clients/:id/revoke", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      await fastify.services.clients.revoke(id);
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.revoke",
        targetType: "client",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  fastify.delete("/api/clients/:id", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "admin");
      const { id } = request.params as { id: string };
      await fastify.services.clients.softDelete(id);
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.delete",
        targetType: "client",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  fastify.post("/api/clients/:id/assign", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { configurationId?: unknown };
      if (typeof body.configurationId !== "string") {
        return reply.status(400).send({ error: "configurationId is required" });
      }
      const result = await fastify.services.clients.assignToConfiguration({
        clientId: id,
        configurationId: body.configurationId,
      });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.assign_config",
        targetType: "client",
        targetId: id,
        meta: { configurationId: body.configurationId, credentialId: result.credentialId },
        ip: request.ip,
      });
      return { ok: true, credentialId: result.credentialId };
    },
  });

  fastify.post("/api/clients/:id/unassign", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { configurationId?: unknown };
      if (typeof body.configurationId !== "string") {
        return reply.status(400).send({ error: "configurationId is required" });
      }
      const count = await fastify.services.clients.unassignFromConfiguration(
        id,
        body.configurationId
      );
      if (count === 0) return reply.status(404).send({ error: "no active assignment" });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.unassign_config",
        targetType: "client",
        targetId: id,
        meta: { configurationId: body.configurationId },
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  fastify.post("/api/clients/:id/rotate-credential", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { configurationId?: unknown };
      if (typeof body.configurationId !== "string") {
        return reply.status(400).send({ error: "configurationId is required" });
      }
      await fastify.services.clients.rotateCredential(id, body.configurationId);
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.rotate_credential",
        targetType: "client",
        targetId: id,
        meta: { configurationId: body.configurationId },
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  fastify.post("/api/clients/:id/revoke-credential", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { configurationId?: unknown };
      if (typeof body.configurationId !== "string") {
        return reply.status(400).send({ error: "configurationId is required" });
      }
      const count = await fastify.services.clients.revokeCredential(id, body.configurationId);
      if (count === 0) return reply.status(404).send({ error: "no active credential" });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.revoke_credential",
        targetType: "client",
        targetId: id,
        meta: { configurationId: body.configurationId },
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  // Export a client-facing artifact. Operation role required: it contains credentials.
  fastify.get("/api/clients/:id/export/:configurationId", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const { id, configurationId } = request.params as { id: string; configurationId: string };
      const result = await fastify.services.configs.exportClientArtifact(id, configurationId);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.export",
        targetType: "client",
        targetId: id,
        meta: { configurationId, protocol: "artifact" },
        ip: request.ip,
      });
      reply.header("content-type", result.contentType ?? "text/plain; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="${safeHeaderFilename(
          result.filename ?? safeFilename(`${id}-${configurationId}`, "client-config.txt")
        )}"`
      );
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      return result.content;
    },
  });

  // URI / content for copy and QR display. Never cached; operator-only.
  fastify.get("/api/clients/:id/uri/:configurationId", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const { id, configurationId } = request.params as { id: string; configurationId: string };
      const result = await fastify.services.configs.exportClientArtifact(id, configurationId);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      reply.header("cache-control", "no-store");
      return { uri: result.uri ?? null, content: result.content, filename: result.filename };
    },
  });

  fastify.get("/api/clients/:id/qr/:configurationId", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const { id, configurationId } = request.params as { id: string; configurationId: string };
      const result = await fastify.services.configs.exportClientArtifact(id, configurationId);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      if (!result.uri) {
        return reply.status(400).send({
          error: "this protocol produces a file, not a scannable connection URI",
        });
      }
      const png = await QRCode.toBuffer(result.uri, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 480,
        color: { dark: "#0b1220", light: "#ffffff" },
      });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "client.qr_viewed",
        targetType: "client",
        targetId: id,
        meta: { configurationId },
        ip: request.ip,
      });
      reply.header("content-type", "image/png");
      reply.header("cache-control", "no-store");
      return reply.send(png);
    },
  });

  void (null as unknown as FastifyReply);
}
