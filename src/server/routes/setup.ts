import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../security/password.js";
import { constantTimeEqual } from "../security/tokens.js";

const setupSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{3,64}$/, "username must be 3-64 chars [a-zA-Z0-9_.-]"),
  password: z
    .string()
    .min(12, "password must be at least 12 characters")
    .max(128)
    .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), "use at least one letter and one digit"),
});

/**
 * First-admin one-time setup flow.
 * - GET /api/setup/status -> whether setup is possible (public).
 * - POST /api/setup       -> creates the first administrator, atomically.
 *
 * It is exposed only while no admin account has ever existed. SETUP_TOKEN is
 * mandatory. After initialization the route is permanently hard-disabled.
 */
export async function setupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/setup/status", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    async handler() {
      const [anyAdmin, anyConfig] = await Promise.all([
        fastify.prisma.adminUser.count({ where: {} }).catch(() => -1),
        fastify.prisma.protocolConfiguration.count({ where: {} }).catch(() => 0),
      ]);
      const databaseReachable = anyAdmin >= 0;
      return {
        needsSetup: databaseReachable && anyAdmin === 0,
        setupEnabled: Boolean(fastify.appConfig.setupToken),
        initialized: databaseReachable ? anyAdmin > 0 : false,
        databaseReachable,
        hasConfigurations: anyConfig > 0,
      };
    },
  });

  fastify.post(
    "/api/setup",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async function handler(request, reply) {
      reply.header("cache-control", "no-store");
      const existing = await fastify.prisma.adminUser.count().catch(() => -1);
      if (existing < 0) {
        return reply.status(503).send({ error: "database unavailable; try again shortly" });
      }
      if (existing > 0) {
        return reply.status(404).send({ error: "not found" });
      }
      const cfg = fastify.appConfig;
      if (!cfg.setupToken) {
        return reply.status(409).send({
          error: "setup is disabled: SETUP_TOKEN is not configured; use `pnpm ops:create-admin`",
          code: "SETUP_DISABLED",
        });
      }
      const headerToken = request.headers["x-setup-token"];
      if (typeof headerToken !== "string" || !constantTimeEqual(headerToken, cfg.setupToken)) {
        await fastify.services.audit.record({
          actorLabel: "anonymous",
          action: "setup.attempt_failed",
          targetType: "admin_user",
          targetId: "(none)",
          meta: {},
          ip: request.ip,
        });
        return reply.status(403).send({ error: "invalid setup token" });
      }
      const parsed = setupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid account details",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }

      const hash = await hashPassword(parsed.data.password);
      try {
        const user = await fastify.prisma.$transaction(
          async (tx) => {
            const count = await tx.adminUser.count();
            if (count > 0) throw Object.assign(new Error("initialized"), { statusCode: 404 });
            const adminRole = await tx.role.upsert({
              where: { name: "admin" },
              update: {},
              create: { name: "admin", description: "Full administrative control" },
            });
            const created = await tx.adminUser.create({
              data: {
                username: parsed.data.username,
                passwordHash: hash,
                roleId: adminRole.id,
              },
            });
            await tx.applicationSetting.upsert({
              where: { key: "panel.installationComplete" },
              update: { value: true },
              create: { key: "panel.installationComplete", value: true },
            });
            return created;
          },
          { isolationLevel: "Serializable" }
        );

        await fastify.services.audit.record({
          actorId: user.id,
          actorLabel: user.username,
          action: "setup.first_admin_created",
          targetType: "admin_user",
          targetId: user.id,
          meta: { username: user.username },
          ip: request.ip,
        });
        return reply.status(201).send({ ok: true });
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404) return reply.status(404).send({ error: "not found" });
        if ((err as { code?: string }).code === "P2034") {
          return reply.status(409).send({ error: "setup is already in progress; retry if needed" });
        }
        throw err;
      }
    }
  );
}
