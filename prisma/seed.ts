/**
 * Idempotent reference-data seed: protocol catalog, roles, settings.
 *
 * SECURITY: This seed creates NO administrator account and no default
 * password. First-admin provisioning uses the one-time SETUP_TOKEN flow or:
 *   pnpm ops:create-admin -- --username <name> --password <strong-random>
 *
 * Run with: pnpm db:seed
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PROTOCOL_CATALOG } from "../src/server/protocols/catalog.js";

const prisma = new PrismaClient();

async function main() {
  for (const p of PROTOCOL_CATALOG) {
    await prisma.protocol.upsert({
      where: { id: p.id },
      update: {
        displayName: p.displayName,
        category: p.category,
        deploymentMode: p.deploymentMode,
        requiresInboundTcp: p.requiresInboundTcp,
        requiresUdp: p.requiresUdp,
        requiresRoot: p.requiresRoot,
        docsUrl: p.docsUrl,
      },
      create: {
        id: p.id,
        displayName: p.displayName,
        category: p.category,
        deploymentMode: p.deploymentMode,
        requiresInboundTcp: p.requiresInboundTcp,
        requiresUdp: p.requiresUdp,
        requiresRoot: p.requiresRoot,
        docsUrl: p.docsUrl,
      },
    });
  }

  for (const role of [
    { name: "admin" as const, description: "Full administrative control" },
    {
      name: "operator" as const,
      description: "Manage clients and configurations, view diagnostics",
    },
    { name: "viewer" as const, description: "Read-only access" },
  ]) {
    await prisma.role.upsert({ where: { name: role.name }, update: {}, create: role });
  }

  const settings: [string, unknown][] = [
    ["ui.defaultLanguage", "en"],
    ["ui.defaultTheme", "dark"],
    ["subscription.defaultFormat", "xray_uri"],
    ["subscription.maxPerClient", 10],
    ["panel.installationComplete", false],
  ];
  for (const [key, value] of settings) {
    await prisma.applicationSetting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as never },
    });
  }

  console.log(
    `[seed] ${PROTOCOL_CATALOG.length} protocols, 3 roles, ${settings.length} settings ready (no admin created).`
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
