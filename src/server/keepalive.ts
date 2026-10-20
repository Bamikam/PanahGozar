import type { AppConfig } from "./env-types.js";

export interface KeepAliveLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface KeepAliveController {
  stop: () => void;
  intervalMs: number;
  target: URL;
}

const HEALTH_PATH = "/api/health";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the only URL this feature may request: the deployment's own public
 * health endpoint. The target is derived from validated PUBLIC_URL, never from
 * user input, which avoids creating an SSRF surface.
 */
export function buildKeepAliveTarget(publicUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(HEALTH_PATH, publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url;
}

/**
 * Best-effort keep-awake loop.
 *
 * This is intentionally a public HTTP round trip to /api/health rather than a
 * no-op timer: some platforms judge activity by inbound edge traffic, so an
 * in-process timer alone would be ineffective. It helps with idle spin-down
 * on free/Serverless hosting, but cannot guarantee uptime: providers may still
 * suspend, restart, throttle, or delete services under plan limits.
 */
export function startKeepAlive(
  cfg: AppConfig,
  logger: KeepAliveLogger
): KeepAliveController | null {
  if (!cfg.keepAliveEnabled) return null;

  const target = buildKeepAliveTarget(cfg.publicUrl);
  if (!target) {
    logger.warn(
      { feature: "keep-alive" },
      "keep-alive disabled: PUBLIC_URL is not a valid http(s) URL"
    );
    return null;
  }

  const intervalMs = cfg.keepAliveIntervalMinutes * 60_000;
  if (cfg.nodeEnv !== "production") {
    logger.warn(
      { feature: "keep-alive", intervalMinutes: cfg.keepAliveIntervalMinutes },
      "keep-alive is enabled outside production; this is usually unnecessary in local development"
    );
  }

  const ping = async (): Promise<void> => {
    try {
      const response = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": "PanahGozar-KeepAlive/1.0",
          accept: "application/json",
        },
      });
      if (!response.ok) {
        logger.warn(
          { feature: "keep-alive", status: response.status },
          "keep-alive health request returned a non-success status"
        );
      }
    } catch (error) {
      logger.warn(
        {
          feature: "keep-alive",
          reason: error instanceof Error ? error.name : "unknown",
        },
        "keep-alive health request failed"
      );
    }
  };

  const timer = setInterval(() => {
    void ping();
  }, intervalMs);
  timer.unref();

  logger.info(
    { feature: "keep-alive", intervalMinutes: cfg.keepAliveIntervalMinutes },
    "keep-alive scheduler started (self health ping through the public entry point)"
  );

  return {
    stop: () => clearInterval(timer),
    intervalMs,
    target,
  };
}
