import { execFileSync } from "node:child_process";

/**
 * Optional last-resort startup migrator. The documented production path runs
 * `prisma migrate deploy` in Render's preDeployCommand or Railway's release
 * start command before this process starts. Set RUN_MIGRATIONS_ON_START=1 only
 * when the platform has no release phase.
 */
export async function migrateIfConfigured(): Promise<void> {
  if (process.env.RUN_MIGRATIONS_ON_START !== "1") return;
  if (!process.env.DATABASE_URL) {
    console.error(
      "[startup] RUN_MIGRATIONS_ON_START=1 but DATABASE_URL is missing; refusing to start."
    );
    process.exit(1);
  }
  console.log("[startup] running prisma migrate deploy...");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  try {
    execFileSync(npx, ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  } catch {
    console.error("[startup] database migrations failed; refusing to serve an unmigrated schema.");
    process.exit(1);
  }
}
