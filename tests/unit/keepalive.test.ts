import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { buildKeepAliveTarget, startKeepAlive } from "../../src/server/keepalive.js";
import type { AppConfig } from "../../src/server/env-types.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  publicUrl: "https://panel.example.test",
  databaseUrl: "postgresql://unused:unused@localhost:5432/unused",
  sessionSecret: "test-session-secret-not-used-32-characters",
  encryptionKey: Buffer.alloc(32, 1),
  setupToken: "",
  logLevel: "error",
  enableRuntimeListeners: false,
  trustProxy: true,
  cookieSecure: true,
  keepAliveEnabled: true,
  keepAliveIntervalMinutes: 3,
  isDev: false,
};

const logger = { info: () => {}, warn: () => {} };

describe("keep-alive target construction", () => {
  it("always targets only the public health endpoint", () => {
    expect(buildKeepAliveTarget("https://panel.example.test")?.toString()).toBe(
      "https://panel.example.test/api/health"
    );
    expect(buildKeepAliveTarget("https://panel.example.test/base/path")?.toString()).toBe(
      "https://panel.example.test/api/health"
    );
    expect(buildKeepAliveTarget("http://localhost:3000")?.pathname).toBe("/api/health");
  });

  it("rejects malformed and non-http protocols", () => {
    expect(buildKeepAliveTarget("not a URL")).toBeNull();
    expect(buildKeepAliveTarget("ftp://panel.example.test")).toBeNull();
    expect(buildKeepAliveTarget("file:///etc/passwd")).toBeNull();
  });

  it("does not schedule anything when disabled", () => {
    const controller = startKeepAlive({ ...baseConfig, keepAliveEnabled: false }, logger);
    expect(controller).toBeNull();
  });

  it("returns a stoppable scheduler without waiting for the interval", () => {
    const controller = startKeepAlive(baseConfig, logger);
    expect(controller).not.toBeNull();
    expect(controller?.intervalMs).toBe(180_000);
    expect(controller?.target.pathname).toBe("/api/health");
    controller?.stop();
  });

  it("performs a real public health request on its schedule", async () => {
    let hits = 0;
    let path = "";
    const server = createServer((req, res) => {
      hits += 1;
      path = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const controller = startKeepAlive(
      {
        ...baseConfig,
        publicUrl: `http://127.0.0.1:${address.port}`,
        keepAliveIntervalMinutes: 0.01,
      },
      logger
    );
    try {
      const deadline = Date.now() + 2500;
      while (hits === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(hits).toBeGreaterThan(0);
      expect(path).toBe("/api/health");
    } finally {
      controller?.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
