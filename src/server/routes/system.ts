import type { FastifyInstance } from "fastify";

/**
 * Health & readiness endpoints.
 * - /api/health: liveness only; no external dependency and no secrets.
 * - /api/ready : readiness; database connectivity + migrations. 503 when a
 *   required dependency is unavailable. Stack traces and DSNs never leak.
 */
export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/health", {
    config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
    async handler(_request, reply) {
      reply.header("cache-control", "no-store");
      return {
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    },
  });

  fastify.get("/api/ready", {
    config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
    async handler(_request, reply) {
      reply.header("cache-control", "no-store");
      const report: {
        status: "ok" | "degraded";
        checks: Record<string, { ok: boolean; detail?: string }>;
      } = { status: "ok", checks: {} };

      try {
        await fastify.prisma.$queryRawUnsafe("SELECT 1");
        report.checks.database = { ok: true };
      } catch {
        report.status = "degraded";
        report.checks.database = {
          ok: false,
          detail: "database connection failed (details suppressed)",
        };
      }

      if (report.checks.database?.ok) {
        try {
          const rows = (await fastify.prisma.$queryRawUnsafe(
            `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
          )) as { migration_name: string }[];
          if (rows.length === 0) {
            report.status = "degraded";
            report.checks.migrations = {
              ok: false,
              detail: "no applied migrations found - run `pnpm db:migrate`",
            };
          } else {
            report.checks.migrations = { ok: true };
          }
        } catch {
          report.status = "degraded";
          report.checks.migrations = {
            ok: false,
            detail: "migration state unavailable - run `pnpm db:migrate`",
          };
        }

        try {
          const roles = await fastify.prisma.role.count();
          report.checks.referenceData = {
            ok: roles > 0,
            ...(roles > 0
              ? {}
              : { detail: "roles are missing - run `pnpm db:seed` or use the setup flow" }),
          };
          if (roles === 0) report.status = "degraded";
        } catch {
          report.checks.referenceData = { ok: false, detail: "reference data check failed" };
          report.status = "degraded";
        }
      }

      return reply.status(report.status === "ok" ? 200 : 503).send(report);
    },
  });
}
