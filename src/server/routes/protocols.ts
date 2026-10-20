import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/auth-plugin.js";
import { PROTOCOL_CATALOG, catalogEntry } from "../protocols/catalog.js";

/**
 * Protocol catalog, runtime status, diagnostics, and audit APIs.
 * Every status is derived from configuration state plus recorded evidence.
 */
export async function protocolRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/protocols", {
    async handler(request) {
      requireAuth(request);
      const [counts, statuses] = await Promise.all([
        fastify.prisma.protocolConfiguration.groupBy({
          by: ["protocolId"],
          where: { deletedAt: null },
          _count: { id: true },
          _max: { updatedAt: true },
        }),
        fastify.services.status.evaluateAll(),
      ]);
      const countMap = new Map(counts.map((c) => [c.protocolId, c._count.id]));
      const statusMap = new Map(statuses.map((s) => [s.protocolId, s]));
      return {
        protocols: PROTOCOL_CATALOG.map((p) => ({
          ...p,
          configurationCount: countMap.get(p.id) ?? 0,
          status: statusMap.get(p.id) ?? null,
        })),
        integrationFormats: [
          {
            id: "xray",
            name: "Xray-core JSON",
            description:
              "Import/export Xray server JSON and download a merged Xray config for active inbounds.",
            docsUrl: "https://xtls.github.io/en/config/",
            runtimeNote:
              "Xray is an implementation ecosystem, not a protocol, and is not run here.",
          },
          {
            id: "singbox",
            name: "sing-box JSON",
            description:
              "Import documented sing-box outbounds and export per-client singbox_json subscriptions.",
            docsUrl: "https://sing-box.sagernet.org/configuration/",
            runtimeNote: "sing-box is not executed in this deployment.",
          },
          {
            id: "subscriptions",
            name: "Client subscriptions",
            description:
              "Base64 URI lists (xray_uri), raw URI lists, and sing-box client JSON. Only compatible artifacts are included.",
            docsUrl: "https://github.com/XTLS/Xray-core",
            runtimeNote:
              "A subscription URL returning config does not prove a server is reachable.",
          },
        ],
      };
    },
  });

  fastify.get("/api/protocols/status", {
    async handler(request) {
      requireAuth(request);
      return { protocols: await fastify.services.status.evaluateAll() };
    },
  });

  fastify.get("/api/protocols/:id/capabilities", {
    async handler(request, reply) {
      requireAuth(request);
      const { id } = request.params as { id: string };
      const adapter = fastify.services.registry.get(id);
      if (!adapter) return reply.status(404).send({ error: "unknown protocol" });
      const capabilities = await adapter.detectCapabilities();
      return {
        protocolId: id,
        displayName: adapter.displayName,
        catalog: catalogEntry(id) ?? null,
        capabilities,
        runtimeStatus: await adapter.getRuntimeStatus(),
      };
    },
  });

  fastify.get("/api/diagnostics", {
    async handler(request) {
      requireAuth(request);
      const facts = await fastify.services.capabilities.factorize();
      const checks = await fastify.services.capabilities.sweep();
      const protocolIds = fastify.services.registry.list().map((a) => a.id);
      const statuses = await fastify.services.status.evaluateAll();
      const dbOk = await fastify.prisma.$queryRawUnsafe("SELECT 1").then(
        () => true,
        () => false
      );
      return {
        generatedAt: new Date().toISOString(),
        nodeVersion: facts.nodeVersion,
        platform: facts.platform,
        arch: facts.arch,
        processUser: facts.processUser,
        isContainer: facts.isContainer,
        cwdWritable: facts.cwdWritable,
        homeDirWritable: facts.homeDirWritable,
        databaseReachable: dbOk,
        allMigrationsApplied: await fastify.services.capabilities.migrationsApplied(),
        runtimeListenersEnabled: fastify.appConfig.enableRuntimeListeners,
        deploymentModel:
          "Single web service: panel HTTP serving + Fastify API. Protocol listeners are external by design.",
        checksSummary: {
          total: checks.length,
          available: checks.filter((c) => c.available).length,
          unavailable: checks.filter((c) => !c.available).length,
        },
        checks,
        supportedProtocols: protocolIds,
        protocols: statuses,
        compatibilityReview: {
          reviewedAt: "2026-10-19",
          sources: [
            "https://docs.railway.com/networking/public-networking/specs-and-limits.md",
            "https://docs.railway.com/networking/tcp-proxy.md",
            "https://render.com/docs/web-services.md",
            "https://render.com/docs/health-checks.md",
            "https://render.com/docs/disks.md",
          ],
        },
      };
    },
  });

  fastify.get("/api/audit", {
    async handler(request) {
      requireAuth(request);
      requireRole(request, "admin");
      const query = (request.query ?? {}) as {
        page?: unknown;
        pageSize?: unknown;
        action?: unknown;
        targetType?: unknown;
      };
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
      const action =
        typeof query.action === "string" && query.action.length <= 120 ? query.action : undefined;
      const targetType =
        typeof query.targetType === "string" && query.targetType.length <= 64
          ? query.targetType
          : undefined;
      const res = await fastify.services.audit.list({ page, pageSize, action, targetType });
      return {
        items: res.items.map((e) => ({
          id: e.id,
          actorId: e.actorId,
          actorLabel: e.actorLabel,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          meta: e.meta,
          ip: e.ip,
          createdAt: e.createdAt.toISOString(),
        })),
        page,
        pageSize,
        total: res.total,
      };
    },
  });
}
