// Validates deployment manifests and core deployment invariants.
// Run: pnpm ops:validate-manifests
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error("  x", msg);
};
const ok = (msg) => console.log("  +", msg);

// ---------------------------------------------------------------- railway --
console.log("railway.json (legacy Config-as-Code; retained for existing services)");
try {
  const rail = JSON.parse(readFileSync(path.join(root, "railway.json"), "utf8"));
  if (rail.$schema !== "https://railway.com/railway.schema.json") {
    fail("schema URL must be https://railway.com/railway.schema.json");
  }
  if (rail.build?.builder !== "RAILPACK") fail("builder should be RAILPACK");
  if (!String(rail.build?.buildCommand ?? "").includes("--frozen-lockfile")) {
    fail("buildCommand must use --frozen-lockfile");
  }
  if (!String(rail.build?.buildCommand ?? "").includes("pnpm build")) {
    fail("buildCommand must run pnpm build");
  }
  if (
    !Array.isArray(rail.deploy?.preDeployCommand) ||
    rail.deploy.preDeployCommand[0] !== "pnpm release"
  ) {
    fail("preDeployCommand must be ['pnpm release']");
  }
  if (rail.deploy?.startCommand !== "pnpm start") fail("startCommand must be pnpm start");
  if (rail.deploy?.healthcheckPath !== "/api/ready") fail("healthcheckPath must be /api/ready");
  if (rail.deploy?.restartPolicyType !== "ON_FAILURE") fail("restartPolicyType must be ON_FAILURE");
  if (typeof rail.deploy?.overlapSeconds !== "number") {
    fail("overlapSeconds must be a number (official schema)");
  }
  if (typeof rail.deploy?.drainingSeconds !== "number") {
    fail("drainingSeconds must be a number (official schema)");
  }
  if ("numReplicas" in (rail.deploy ?? {}))
    fail("single-instance in-memory limits: omit numReplicas");
  ok("structure valid");
} catch (e) {
  fail(`cannot parse: ${e.message}`);
}

// ----------------------------------------------------------------- render --
console.log("render.yaml");
try {
  const doc = parseYaml(readFileSync(path.join(root, "render.yaml"), "utf8"));
  const webs = (doc.services ?? []).filter((s) => s.type === "web");
  if (webs.length !== 1) fail("expected exactly one web service");
  for (const s of webs) {
    if (s.runtime !== "node") fail("runtime must be node");
    if (!["0.5c-512mb", "1c-2g", "2c-4g"].includes(s.plan)) {
      fail(`unexpected web plan: ${s.plan}`);
    }
    if (!String(s.buildCommand ?? "").includes("--frozen-lockfile")) {
      fail("buildCommand must use --frozen-lockfile");
    }
    if (!String(s.buildCommand ?? "").includes("pnpm build")) fail("buildCommand must build");
    if (s.preDeployCommand !== "pnpm release") fail("preDeployCommand must be pnpm release");
    if (s.startCommand !== "pnpm start") fail("startCommand must be pnpm start");
    if (s.healthCheckPath !== "/api/ready") fail("healthCheckPath must be /api/ready");
    if (!s.maxShutdownDelaySeconds) fail("maxShutdownDelaySeconds missing");
    const vars = s.envVars ?? [];
    const dbVar = vars.find((v) => v.key === "DATABASE_URL");
    if (!dbVar?.fromDatabase) fail("DATABASE_URL must reference managed DB");
    for (const required of ["SESSION_SECRET", "ENCRYPTION_KEY", "SETUP_TOKEN", "NODE_ENV"]) {
      if (!vars.some((v) => v.key === required)) fail(`${required} env var missing`);
    }
    for (const secret of ["SESSION_SECRET", "ENCRYPTION_KEY"]) {
      const entry = vars.find((v) => v.key === secret);
      if (entry?.value !== undefined) fail(`${secret} must not be hardcoded`);
      if (!entry?.generateValue) fail(`${secret} should use generateValue`);
    }
    if (vars.find((v) => v.key === "SETUP_TOKEN")?.value !== undefined) {
      fail("SETUP_TOKEN must not be hardcoded");
    }
    if (!String(s.healthCheckPath).startsWith("/")) fail("healthCheckPath must start with /");
  }
  const dbs = doc.databases ?? [];
  if (dbs.length !== 1) fail("expected exactly one managed postgres database");
  for (const db of dbs) {
    if (!["0.1c-256mb", "0.5c-1g", "1c-2g"].includes(db.plan)) {
      fail(`unexpected database plan: ${db.plan}`);
    }
    if (!db.postgresMajorVersion) fail("postgresMajorVersion missing");
    if (!Array.isArray(db.ipAllowList)) fail("ipAllowList must be explicit");
  }
  ok("structure valid");
} catch (e) {
  fail(`cannot parse: ${e.message}`);
}

// --------------------------------------------------------------- packaging --
console.log("package + lockfile");
try {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.packageManager !== "pnpm@9.6.0") fail("packageManager must pin pnpm 9.6.0");
  if (pkg.type !== "module") fail('package.json must declare "type": "module"');
  for (const script of ["build", "start", "release", "db:migrate", "db:seed", "ops:create-admin"]) {
    if (!pkg.scripts?.[script]) fail(`script "${script}" missing`);
  }
  if (pkg.dependencies?.prisma === undefined) {
    fail("prisma CLI must be a production dependency for release");
  }
  if (pkg.dependencies?.tsx === undefined) {
    fail("tsx must be a production dependency for seed/release");
  }
  if (!existsSync(path.join(root, "pnpm-lock.yaml"))) fail("pnpm-lock.yaml missing");
  if (pkg.engines?.node === undefined) fail("engines.node missing");
  ok("scripts and lockfile present");
} catch (e) {
  fail(`cannot inspect package: ${e.message}`);
}

// ----------------------------------------------------------- docker-entry --
console.log("Dockerfile + docker-entrypoint.sh");
try {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entry = readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");
  if (!entry.includes('exec "$@"')) fail("entrypoint must exec the process for SIGTERM handling");
  if (!dockerfile.includes("USER node")) fail("container must run as non-root");
  if (dockerfile.includes("--privileged")) fail("privileged container is not allowed");
  if (dockerfile.includes("network_mode: host")) fail("host networking is not allowed");
  if (!dockerfile.includes("HEALTHCHECK")) fail("Docker healthcheck missing");
  if (!dockerfile.includes("RUN_MIGRATIONS_ON_START=1")) {
    fail("Docker release migration flag missing");
  }
  if (!dockerfile.includes("COPY --from=build --chown=node:node /app/src ./src")) {
    fail("seed sources must be available in runtime image");
  }
  ok("unprivileged HTTP-only container");
} catch (e) {
  fail(`cannot inspect Docker files: ${e.message}`);
}

// ---------------------------------------------------------------- env docs --
console.log(".env.example");
try {
  const env = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const key of [
    "NODE_ENV",
    "PORT",
    "PUBLIC_URL",
    "DATABASE_URL",
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "SETUP_TOKEN",
    "LOG_LEVEL",
    "ENABLE_RUNTIME_LISTENERS",
  ]) {
    if (!new RegExp(`^${key}=`, "m").test(env)) fail(`${key} missing from .env.example`);
  }
  if (/generate-me|changeme/.test(env.replace(/#.*$/gm, ""))) {
    fail("real-looking placeholder secret values should be empty or clearly invalid");
  }
  ok("documented variables present");
} catch (e) {
  fail(`cannot inspect .env.example: ${e.message}`);
}

// --------------------------------------------------------------------- ci --
console.log(".github/workflows/ci.yml");
try {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  if (ci.includes("--frozen-lockfile=false")) fail("CI must use --frozen-lockfile");
  const requiredSteps = [
    "pnpm db:generate",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm ops:validate-manifests",
    "pnpm audit --prod --audit-level=high",
  ];
  for (const step of requiredSteps) {
    if (!ci.includes(step)) fail(`CI step missing: ${step}`);
  }
  if (!ci.includes("pnpm db:migrate")) fail("integration CI must apply migrations");
  if (!ci.includes("pnpm test:integration")) fail("integration CI job missing");
  ok("CI gates present");
} catch (e) {
  fail(`cannot inspect CI: ${e.message}`);
}

// ------------------------------------------------------------- migrations --
console.log("Prisma migrations");
try {
  const migration = readFileSync(
    path.join(root, "prisma/migrations/20261018000000_init/migration.sql"),
    "utf8"
  );
  for (const table of [
    '"protocols"',
    '"roles"',
    '"admin_users"',
    '"sessions"',
    '"clients"',
    '"credential_references"',
    '"protocol_configurations"',
    '"configuration_versions"',
    '"application_settings"',
    '"subscriptions"',
    '"runtime_capabilities"',
    '"runtime_health_checks"',
    '"audit_events"',
  ]) {
    if (!migration.includes(`CREATE TABLE ${table}`)) fail(`migration missing table ${table}`);
  }
  if (!migration.includes("tokenRotatedAt")) fail("subscription token rotation column missing");
  if (migration.includes('"credential_references_clientId_configurationId_kind_key"')) {
    fail("credential unique constraint blocks credential history");
  }
  ok("migration structure valid");
} catch (e) {
  fail(`cannot inspect migration: ${e.message}`);
}

if (failed) {
  console.error("\ndeployment manifest validation FAILED");
  process.exit(1);
}
console.log("\ndeployment manifest validation passed.");
