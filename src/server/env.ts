import { z } from "zod";
import type { AppConfig } from "./env-types.js";

/**
 * Startup environment validation. Fails fast with a clear, sanitized message
 * if required configuration is invalid. Secret values are never echoed.
 *
 * ENCRYPTION_KEY accepts either:
 *  - 64 hexadecimal characters (32 bytes), preferably from `openssl rand -hex 32`, or
 *  - a base64-encoded 32-byte value (what Render's `generateValue: true` emits).
 */

const hex64 = /^[0-9a-fA-F]{64}$/;
const isTestEnv = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "test";

export const EnvSchema = (env: NodeJS.ProcessEnv) =>
  z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: z
      .string()
      .url("PUBLIC_URL must be an absolute http(s) URL")
      .default("http://localhost:5173"),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
        "DATABASE_URL must be a postgres:// or postgresql:// connection string"
      ),
    SESSION_SECRET: z
      .string()
      .min(32, "SESSION_SECRET must be at least 32 characters")
      .refine(
        (v) => !/generate-me|changeme|placeholder/i.test(v),
        "SESSION_SECRET is still its placeholder value - generate a random secret"
      ),
    ENCRYPTION_KEY: isTestEnv(env)
      ? z.string().default("0000000000000000000000000000000000000000000000000000000000000000")
      : z.string().min(1, "ENCRYPTION_KEY is required"),
    SETUP_TOKEN: z
      .string()
      .max(200)
      .optional()
      .default("")
      .refine(
        (v) => v === "" || v.length >= 16,
        "SETUP_TOKEN must be empty (disabled) or at least 16 characters"
      ),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    // Runtime listeners are intentionally unsupported in the single-service
    // deployment. The switch is read for diagnostics only; enabling it does
    // not create listeners unless a verified runtime implementation exists.
    ENABLE_RUNTIME_LISTENERS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
    // Optional keep-awake self health ping. It prevents common idle
    // spin-downs by generating an outbound+inbound request to our own public
    // health endpoint. It cannot guarantee platform availability.
    KEEP_ALIVE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    KEEP_ALIVE_INTERVAL_MINUTES: z.coerce
      .number()
      .int()
      .min(2, "KEEP_ALIVE_INTERVAL_MINUTES must be at least 2")
      .max(14, "KEEP_ALIVE_INTERVAL_MINUTES must be at most 14")
      .default(3),
  });

export function decodeEncryptionKey(value: string): Buffer | null {
  if (hex64.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? decoded : null;
}

function sanitizedExit(message: string): never {
  console.error(`\n[panahgozar] ${message}\n`);
  console.error("No secret values are printed. See .env.example for every variable.\n");
  process.exit(1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Platform-provided public URLs are safe defaults and avoid a boot loop when
  // the operator did not duplicate the value into PUBLIC_URL.
  const source: NodeJS.ProcessEnv = { ...env };
  if (!source.PUBLIC_URL) {
    if (typeof source.RENDER_EXTERNAL_URL === "string" && source.RENDER_EXTERNAL_URL) {
      source.PUBLIC_URL = source.RENDER_EXTERNAL_URL;
    } else if (typeof source.RAILWAY_PUBLIC_DOMAIN === "string" && source.RAILWAY_PUBLIC_DOMAIN) {
      source.PUBLIC_URL = `https://${source.RAILWAY_PUBLIC_DOMAIN.replace(/^https?:\/\//, "")}`;
    }
  }

  const parsed = EnvSchema(source).safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`)
      .join("\n");
    sanitizedExit(
      `Invalid environment configuration. Correct these variables and restart:\n${issues}`
    );
  }

  const c = parsed.data;
  const publicUrl = c.PUBLIC_URL.replace(/\/+$/, "");
  if (c.NODE_ENV === "production") {
    if (!source.PUBLIC_URL) {
      sanitizedExit(
        "PUBLIC_URL is required in production (or provide RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN)."
      );
    }
    if (!/^https?:\/\//i.test(publicUrl)) {
      sanitizedExit("PUBLIC_URL must start with http:// or https://.");
    }
  }

  const encryptionKey = decodeEncryptionKey(c.ENCRYPTION_KEY);
  if (!encryptionKey) {
    sanitizedExit(
      "ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or as base64. " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  if (c.NODE_ENV === "production" && encryptionKey.every((byte) => byte === 0)) {
    sanitizedExit("ENCRYPTION_KEY must not be the all-zero placeholder in production.");
  }

  const cookieSecure =
    c.COOKIE_SECURE === "auto"
      ? c.NODE_ENV === "production" && publicUrl.startsWith("https://")
      : c.COOKIE_SECURE === "true";

  if (c.SETUP_TOKEN && c.SETUP_TOKEN.length < 16) {
    sanitizedExit("SETUP_TOKEN must be at least 16 characters when enabled.");
  }

  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    publicUrl,
    databaseUrl: c.DATABASE_URL,
    sessionSecret: c.SESSION_SECRET,
    encryptionKey,
    setupToken: c.SETUP_TOKEN ?? "",
    logLevel: c.LOG_LEVEL,
    enableRuntimeListeners: c.ENABLE_RUNTIME_LISTENERS,
    trustProxy: c.TRUST_PROXY,
    cookieSecure,
    keepAliveEnabled: c.KEEP_ALIVE_ENABLED,
    keepAliveIntervalMinutes: c.KEEP_ALIVE_INTERVAL_MINUTES,
    isDev: c.NODE_ENV === "development",
  };
}
