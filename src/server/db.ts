import { PrismaClient } from "@prisma/client";
import type { AppConfig } from "./env-types.js";

declare global {
  // eslint-disable-next-line no-var
  var __panahPrisma: PrismaClient | undefined;
}

/**
 * Singleton PrismaClient. DATABASE_URL comes from approved env validation;
 * no hardcoded credentials exist anywhere. The application database user is
 * provisioned with least privilege (schema-level DML + migration DML only —
 * see docs/deployment.md, "Database least privilege").
 */
export function createDb(cfg: AppConfig): PrismaClient {
  const existing = globalThis.__panahPrisma;
  if (existing) return existing;
  const client = new PrismaClient({
    datasources: { db: { url: cfg.databaseUrl } },
    log: cfg.nodeEnv === "development" ? ["warn", "error"] : ["error"],
  });
  globalThis.__panahPrisma = client;
  return client;
}
