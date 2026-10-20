import type { FastifyInstance } from "fastify";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";
import type { ValidationIssue } from "../protocols/types.js";

function issueDetails(issues: ValidationIssue[] | { path: string; message: string }[]) {
  return issues;
}

/**
 * Configuration API - CRUD, versions, rollback, preview, imports/exports.
 * External imports are untrusted and validated before storage.
 */
export async function configurationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/configurations", {
    async handler(request) {
      requireAuth(request);
      const query = (request.query ?? {}) as { protocolId?: unknown };
      const protocolId =
        typeof query.protocolId === "string" && query.protocolId.length <= 32
          ? query.protocolId
          : undefined;
      return fastify.services.configs.list(protocolId);
    },
  });

  fastify.post("/api/configurations/validate", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const body = (request.body ?? {}) as { protocolId?: unknown; config?: unknown };
      if (typeof body.protocolId !== "string") {
        return reply.status(400).send({ error: "protocolId is required" });
      }
      const result = await fastify.services.configs.validatePreview(body.protocolId, body.config);
      // Validation is a successful query even when the candidate is invalid;
      // the response itself carries valid=false and structured issues.
      return reply.status(200).send(result);
    },
  });

  fastify.post("/api/configurations", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const result = await fastify.services.configs.create(request.body, request.sessionUser!.id);
      if (!result.ok) {
        return reply.status(400).send({ error: "validation failed", details: result.issues });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.create",
        targetType: "configuration",
        targetId: result.value!.id,
        meta: { protocolId: result.value!.protocolId, name: result.value!.name },
        ip: request.ip,
      });
      return reply.status(201).send(result.value);
    },
  });

  fastify.patch("/api/configurations/:id", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const result = await fastify.services.configs.update(
        id,
        request.body,
        request.sessionUser!.id
      );
      if (!result.ok) {
        return reply.status(400).send({
          error: "validation failed",
          details: issueDetails(result.issues),
        });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.update",
        targetType: "configuration",
        targetId: id,
        meta: { fields: Object.keys((request.body as object) ?? {}) },
        ip: request.ip,
      });
      return result.value;
    },
  });

  fastify.post("/api/configurations/:id/rollback", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { versionNumber?: unknown };
      const versionNumber = Number(body.versionNumber);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        return reply.status(400).send({ error: "versionNumber must be a positive integer" });
      }
      const result = await fastify.services.configs.rollbackToVersion(
        id,
        versionNumber,
        request.sessionUser!.id
      );
      if (!result.ok) {
        return reply.status(400).send({ error: "rollback failed", details: result.issues });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.rollback",
        targetType: "configuration",
        targetId: id,
        meta: { toVersion: versionNumber },
        ip: request.ip,
      });
      return result.value;
    },
  });

  fastify.get("/api/configurations/:id/versions", {
    async handler(request) {
      requireAuth(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as { page?: unknown; pageSize?: unknown };
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
      return fastify.services.configs.versions(id, page, pageSize);
    },
  });

  fastify.delete("/api/configurations/:id", {
    async handler(request) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "admin");
      const { id } = request.params as { id: string };
      await fastify.services.configs.softDelete(id);
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.delete",
        targetType: "configuration",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  // ---- Import (untrusted, strict) ------------------------------------------
  fastify.post("/api/configurations/import/xray", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const body = (request.body ?? {}) as {
        protocolId?: unknown;
        text?: unknown;
        publicHost?: unknown;
      };
      if (typeof body.protocolId !== "string" || typeof body.text !== "string") {
        return reply.status(400).send({ error: "protocolId and text are required" });
      }
      if (body.publicHost !== undefined && typeof body.publicHost !== "string") {
        return reply.status(400).send({ error: "publicHost must be a string" });
      }
      const result = await fastify.services.configs.importExternal(
        body.protocolId,
        body.text,
        "import-xray",
        request.sessionUser!.id,
        body.publicHost
      );
      if (!result.ok) {
        return reply.status(400).send({ error: "import rejected", details: result.issues });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.import_xray",
        targetType: "configuration",
        targetId: result.value!.id,
        meta: { protocolId: body.protocolId },
        ip: request.ip,
      });
      return reply.status(201).send(result.value);
    },
  });

  fastify.post("/api/configurations/import/singbox", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "operator");
      const body = (request.body ?? {}) as {
        protocolId?: unknown;
        text?: unknown;
        publicHost?: unknown;
      };
      if (typeof body.protocolId !== "string" || typeof body.text !== "string") {
        return reply.status(400).send({ error: "protocolId and text are required" });
      }
      const result = await fastify.services.configs.importExternal(
        body.protocolId,
        body.text,
        "import-singbox",
        request.sessionUser!.id,
        typeof body.publicHost === "string" ? body.publicHost : undefined
      );
      if (!result.ok) {
        return reply.status(400).send({ error: "import rejected", details: result.issues });
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.import_singbox",
        targetType: "configuration",
        targetId: result.value!.id,
        meta: { protocolId: body.protocolId },
        ip: request.ip,
      });
      return reply.status(201).send(result.value);
    },
  });

  // ---- Export ---------------------------------------------------------------
  fastify.get("/api/export/xray-skeleton", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const content = await fastify.services.configs.exportXraySkeleton();
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.export_xray_skeleton",
        targetType: "configuration",
        targetId: "all",
        meta: {},
        ip: request.ip,
      });
      reply.header("content-type", "application/json");
      reply.header("content-disposition", 'attachment; filename="xray-server-config.json"');
      reply.header("cache-control", "no-store");
      return content;
    },
  });

  fastify.get("/api/configurations/:id/export/server", {
    async handler(request, reply) {
      requireAuth(request);
      requireRole(request, "operator");
      const { id } = request.params as { id: string };
      const exported = await fastify.services.configs.exportServerArtifact(id);
      if (!exported.ok || !exported.result) {
        return reply.status(400).send({ error: exported.error ?? "export failed" });
      }
      const safeName = (exported.result.filename || "server-config")
        .replace(/[^A-Za-z0-9_.-]+/g, "-")
        .slice(0, 100);
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "config.export_server",
        targetType: "configuration",
        targetId: id,
        meta: {},
        ip: request.ip,
      });
      reply.header("content-type", exported.result.contentType);
      reply.header("content-disposition", `attachment; filename="${safeName}"`);
      reply.header("cache-control", "no-store");
      return exported.result.content;
    },
  });
}
