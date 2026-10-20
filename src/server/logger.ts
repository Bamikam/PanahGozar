import pino from "pino";
import type { AppConfig } from "./env-types.js";

/**
 * Redaction list. Pino scrubs these keys anywhere in the object graph before
 * serializing. The panel must never log passwords, private keys, session
 * tokens, or subscription URLs (which embed bearer-like tokens).
 */
export const SENSITIVE_KEY_PATTERNS = [
  "password",
  "passphrase",
  "secret",
  "passwordHash",
  "privateKey",
  "private_key",
  "sealedSecret",
  "token",
  "authorization",
  "cookie",
  "csrf",
  "sessionToken",
  "subToken",
  "url",
  "uuid",
];

/** Defensive manual redactor for arbitrary metadata objects (audit meta etc.) */
const SENSITIVE_KEY_RE =
  /password|passphrase|secret|private[_-]?key|token|authorization|cookie|csrf|url|uuid|cred/i;

export function redactMeta(input: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8 || input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return { value: "[non-object-scrubbed]" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[scrubbed]";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = redactMeta(v, depth + 1);
    } else if (Array.isArray(v)) {
      out[k] = v.length > 0 ? "[array-redacted]" : [];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Subscription URLs are bearer credentials: never let a token reach a log. */
export function redactRequestUrl(url: string): string {
  const [pathname = "/", query = ""] = url.split("?", 2);
  const safePath = pathname.replace(/^(\/api\/sub\/)[^/]+/, "$1[redacted]");
  const params = new URLSearchParams(query);
  const redactedQuery = [...params.entries()]
    .map(([key, value]) =>
      /token|secret|key|password/i.test(key)
        ? `${encodeURIComponent(key)}=[redacted]`
        : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
  return redactedQuery ? `${safePath}?${redactedQuery}` : safePath;
}

export function buildLogger(cfg: AppConfig) {
  const redactList = SENSITIVE_KEY_PATTERNS.flatMap((k) => [
    `${k}`,
    `*.${k}`,
    `*.${k}.*`,
    `${k}.*`,
    `err.${k}`,
  ]);
  return pino({
    level: cfg.nodeEnv === "test" ? "silent" : cfg.logLevel,
    redact: {
      paths: redactList,
      censor: "[redacted]",
    },
    serializers: {
      req(request: {
        method?: string;
        url?: string;
        headers?: Record<string, unknown>;
        ip?: string;
        remoteAddress?: string;
      }) {
        return {
          method: request.method,
          url: redactRequestUrl(request.url ?? "/"),
          remoteAddress: request.ip ?? request.remoteAddress,
          userAgent:
            typeof request.headers?.["user-agent"] === "string"
              ? request.headers["user-agent"].slice(0, 160)
              : undefined,
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
    },
    base: { app: "panahgozar", env: cfg.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
