import type { FastifyInstance } from "fastify";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";
import { z } from "zod";

const SettingsSchema = z
  .object({
    uiDefaultLanguage: z.enum(["en", "fa"]).optional(),
    uiDefaultTheme: z.enum(["dark", "light"]).optional(),
    subscriptionDefaultFormat: z.enum(["xray_uri", "raw_uri", "singbox_json"]).optional(),
    subscriptionMaxPerClient: z.number().int().min(1).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "no settings provided");

const SETTING_KEYS = {
  uiDefaultLanguage: "ui.defaultLanguage",
  uiDefaultTheme: "ui.defaultTheme",
  subscriptionDefaultFormat: "subscription.defaultFormat",
  subscriptionMaxPerClient: "subscription.maxPerClient",
} as const;

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/settings", {
    async handler(request, reply) {
      requireAuth(request);
      reply.header("cache-control", "no-store");
      const rows = await fastify.prisma.applicationSetting.findMany();
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return {
        settings: {
          uiDefaultLanguage: byKey.get(SETTING_KEYS.uiDefaultLanguage) ?? "en",
          uiDefaultTheme: byKey.get(SETTING_KEYS.uiDefaultTheme) ?? "dark",
          subscriptionDefaultFormat:
            byKey.get(SETTING_KEYS.subscriptionDefaultFormat) ?? "xray_uri",
          subscriptionMaxPerClient: byKey.get(SETTING_KEYS.subscriptionMaxPerClient) ?? 10,
          installationComplete: byKey.get("panel.installationComplete") ?? false,
        },
        runtime: {
          publicUrl: fastify.appConfig.publicUrl,
          runtimeListenersEnabled: fastify.appConfig.enableRuntimeListeners,
          nodeEnv: fastify.appConfig.nodeEnv,
          nodeVersion: process.version,
        },
      };
    },
  });

  fastify.patch("/api/settings", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "admin");
      const parsed = SettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid settings",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
      await fastify.prisma.$transaction(async (tx) => {
        for (const [field, value] of entries) {
          const key = SETTING_KEYS[field as keyof typeof SETTING_KEYS];
          if (!key) continue;
          await tx.applicationSetting.upsert({
            where: { key },
            update: { value: value as never, updatedById: request.sessionUser!.id },
            create: { key, value: value as never, updatedById: request.sessionUser!.id },
          });
        }
      });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "settings.update",
        targetType: "application_setting",
        targetId: "global",
        meta: { keys: entries.map(([k]) => k) },
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  // Dashboard stats. Every number derives from PostgreSQL or an explicitly
  // verified health check. No fabricated users, bandwidth, uptime or traffic.
  fastify.get("/api/dashboard", {
    async handler(request, reply) {
      requireAuth(request);
      reply.header("cache-control", "no-store");
      const stats = await fastify.services.status.overviewStats();
      const recentEvents = await fastify.services.audit.recent(8);
      return {
        totalClients: stats.totalClients,
        activeClients: stats.activeClients,
        disabledClients: stats.disabledClients,
        expiredClients: stats.expiredClients,
        expiringWithinDays: { clients: stats.expiringClients7d, windowDays: 7 },
        configuredProtocols: stats.configuredProtocols,
        verifiedRunningProtocols: stats.verifiedRunningProtocols,
        runtimeNote:
          "Protocol runtimes are externally hosted in this deployment. The dashboard never fabricates live usage, bandwidth, or uptime.",
        activeSubscriptions: stats.activeSubscriptions,
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          action: e.action,
          actorLabel: e.actorLabel,
          createdAt: e.createdAt.toISOString(),
          targetType: e.targetType,
          targetId: e.targetId,
          meta: (e.meta ?? {}) as Record<string, unknown>,
          actorId: e.actorId,
          ip: e.ip,
        })),
      };
    },
  });
}
