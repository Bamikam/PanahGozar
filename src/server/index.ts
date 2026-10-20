import "dotenv/config";
import { buildApp } from "./app.js";
import { migrateIfConfigured } from "./migrate.js";
import { loadConfig } from "./env.js";
import { startKeepAlive } from "./keepalive.js";

/**
 * Production entry point:
 * - validates environment before binding,
 * - respects PORT and binds 0.0.0.0 (Railway/Render),
 * - serves the SPA and REST API from one Fastify deployment,
 * - handles SIGTERM/SIGINT with bounded graceful shutdown.
 */
async function main(): Promise<void> {
  await migrateIfConfigured();
  const cfg = loadConfig();
  const { app, db } = await buildApp({ cfg });

  const address = await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(
    { address, env: cfg.nodeEnv, port: cfg.port, publicUrl: cfg.publicUrl },
    "panahgozar HTTP service listening"
  );

  const keepAlive = startKeepAlive(cfg, app.log);

  // Record capability evidence without blocking readiness or performing any
  // privileged probe. Failure is logged and exposed by /api/diagnostics.
  void app.services.capabilities
    .sweep()
    .then((checks) =>
      app.log.info(
        { total: checks.length, available: checks.filter((c) => c.available).length },
        "runtime capability sweep recorded"
      )
    )
    .catch((err: unknown) => {
      app.log.warn(
        { reason: err instanceof Error ? err.message : "unknown" },
        "runtime capability sweep could not be persisted"
      );
    });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "graceful shutdown started");
    const timeout = setTimeout(() => {
      app.log.error("graceful shutdown timed out; exiting");
      process.exit(1);
    }, 25_000);
    timeout.unref();
    try {
      keepAlive?.stop();
      await app.close();
      await db.$disconnect();
      app.log.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      app.log.error(
        { reason: err instanceof Error ? err.message : "unknown" },
        "graceful shutdown failed"
      );
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(
    "[panahgozar] fatal startup error:",
    err instanceof Error ? err.message : "unknown error"
  );
  process.exit(1);
});
