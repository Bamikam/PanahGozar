/**
 * Protected first-admin CLI (alternative to the HTTP setup flow).
 * Run in the deployment environment (Railway/Render shell or local docker):
 *
 *   pnpm ops:create-admin -- --username admin --password 'S0m3LongRandom!'
 *
 * SECURITY: no default password exists in the codebase; a short password is
 * refused. The command refuses to run when an admin already exists unless
 * --force-yes is passed to confirm you understand the implications.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { randomInt } from "node:crypto";
import { hashPassword } from "../src/server/security/password.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2).split("=")[0];
      if (!key) continue;
      const inline = a.includes("=");
      out[key] = inline ? a.slice(a.indexOf("=") + 1) : (argv[++i] ?? "");
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username;
  const password = args["password"];
  const email = args.email ?? null;

  if (!username || !password) {
    console.error("usage: pnpm ops:create-admin -- --username <name> --password <strong-random>");
    console.error("       generate a password with: openssl rand -base64 16");
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    console.error("username must be 3-64 chars [a-zA-Z0-9_.-]");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("password too short (minimum 12 characters) — refusing.");
    console.error("generate one with: openssl rand -base64 16");
    process.exit(1);
  }

  const db = new PrismaClient();
  try {
    const existing = await db.adminUser.count();
    if (existing > 0 && args["force-yes"] !== "sure") {
      console.error(
        `An admin account already exists. Continuing would create another administrator.\n` +
          `If you truly intend this, add: --force-yes sure`
      );
      process.exit(1);
    }
    const adminRole = await db.role.findUnique({ where: { name: "admin" } });
    if (!adminRole) {
      console.error("roles not provisioned — run migrations + seed first (pnpm setup).");
      process.exit(1);
    }
    const hash = await hashPassword(password);
    const user = await db.adminUser.create({
      data: { username, passwordHash: hash, roleId: adminRole.id },
    });
    await db.auditEvent.create({
      data: {
        actorLabel: "cli",
        action: "cli.create_admin",
        targetType: "admin_user",
        targetId: user.id,
        meta: { username },
      },
    });
    console.log(
      `admin user ${JSON.stringify(username)} created with id ${JSON.stringify(user.id)}\n` +
        `password: [-never printed-] login via the panel.`
    );
    void randomInt;
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
