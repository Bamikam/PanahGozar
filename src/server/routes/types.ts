import type { FastifyInstance } from "fastify";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";
import { z } from "zod";
import { ProtocolRegistry } from "../protocols/registry.js";
import { EnvironmentFacts } from "../capabilities/runtime-detector.js";

declare module "fastify" {
  interface FastifyInstance {
    services: {
      audit: import("../audit/audit-service.js").AuditService;
      clients: import("../services/client-service.js").ClientService;
      configs: import("../services/config-service.js").ConfigService;
      subscriptions: import("../services/subscription-service.js").SubscriptionService;
      status: import("../services/status-service.js").StatusService;
      registry: ProtocolRegistry;
      capabilities: {
        factorize(): Promise<EnvironmentFacts>;
        sweep(): Promise<import("../capabilities/runtime-detector.js").CapabilityCheck[]>;
        migrationsApplied(): Promise<boolean>;
      };
    };
    prisma: import("@prisma/client").PrismaClient;
    appConfig: import("../env-types.js").AppConfig;
  }
}

void ProtocolRegistry;
void z;
