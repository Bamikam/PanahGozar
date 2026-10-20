import { z } from "zod";
import {
  HostSchema,
  PortSchema,
  formatHostForAuthority,
  zodIssues,
  type ZodValidationIssue,
} from "../primitives.js";
import type {
  ProtocolAdapter,
  ValidationResult,
  ProtocolCapabilities,
  ClientConfigInput,
  GeneratedConfig,
  RuntimeStatus,
  ExportResult,
  ExportCredential,
} from "../types.js";

/**
 * Shadowsocks adapter (Xray-core outbound/inbound shadowsocks).
 * URI follows SIP002: ss://base64(method:password)@host:port#remark
 */

const SUPPORTED_METHODS = [
  "aes-256-gcm",
  "aes-128-gcm",
  "chacha20-poly1305",
  "chacha20-ietf-poly1305",
  "xchacha20-poly1305",
] as const;

const ShadowsocksConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  method: z.enum(SUPPORTED_METHODS),
  // AEAD methods only; stream ciphers are rejected (deprecated & insecure).
  network: z.enum(["tcp", "tcp,udp"]).default("tcp"),
  uotUdp: z.boolean().default(false),
});

export function buildShadowsocksUri(
  method: string,
  password: string,
  host: string,
  port: number,
  remark: string
): string {
  const userinfo = Buffer.from(`${method}:${password}`, "utf8").toString("base64");
  // SIP002 uses base64url without padding for userinfo
  const safeUserinfo = userinfo.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const safeRemark = remark.trim() || "SS";
  return `ss://${safeUserinfo}@${formatHostForAuthority(host)}:${port}#${encodeURIComponent(safeRemark)}`;
}

export function buildXrayInboundShadowsocks(config: {
  port: number;
  method: string;
  uotUdp: boolean;
  clients?: { password: string; label?: string }[];
}): Record<string, unknown> {
  const users = (config.clients ?? []).map((c) => ({
    password: c.password,
    method: config.method,
    email: c.label,
    level: 0,
  }));
  return {
    tag: "ss-in",
    port: config.port,
    listen: "0.0.0.0",
    protocol: "shadowsocks",
    settings: {
      method: config.method,
      // Xray requires a top-level password even in multi-user mode.
      password: users[0]?.password ?? "<provision-at-least-one-client>",
      network: config.uotUdp ? "tcp,udp" : "tcp",
      ota: false,
      users,
    },
  };
}

export class ShadowsocksAdapter implements ProtocolAdapter {
  readonly id = "shadowsocks";
  readonly displayName = "Shadowsocks";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: true,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "Shadowsocks requires a listener (Xray-core or a shadowsocks server). This deployment exposes " +
        "HTTP(S) only; run the server externally and manage it from the panel.",
      checks: [{ key: "xray.binary", available: false, reason: "no binary in PATH" }],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = ShadowsocksConfigSchema.safeParse(config);
    if (!parsed.success) {
      const issues: ZodValidationIssue[] = zodIssues(parsed.error);
      return { valid: false, issues };
    }
    return {
      valid: true,
      issues: [],
      normalized: parsed.data as unknown as Record<string, unknown>,
    };
  }

  async generateClientConfig(input: ClientConfigInput): Promise<GeneratedConfig> {
    const password = input.credential.password;
    const method = input.settings.method;
    if (!password) throw new Error("Shadowsocks credential is missing its password");
    if (typeof method !== "string")
      throw new Error("Shadowsocks configuration is missing its method");
    const uri = buildShadowsocksUri(
      method,
      password,
      input.serverHost,
      input.serverPort,
      input.remark
    );
    return {
      content: uri,
      uri,
      compatibleSubscriptionFormats: ["xray_uri", "raw_uri", "singbox_json"],
    };
  }

  async generateSingboxOutbound(input: ClientConfigInput): Promise<Record<string, unknown>> {
    const password = input.credential.password;
    const method = input.settings.method;
    if (!password || typeof method !== "string") {
      throw new Error("Shadowsocks credential or method is missing");
    }
    return {
      type: "shadowsocks",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      method,
      password,
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No Shadowsocks listener is active in this deployment. Configuration and credentials are " +
        "managed here; run the server on an externally-hosted machine.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const clients = credentials
      .filter((c) => typeof c.secret.password === "string")
      .map((c) => ({ password: c.secret.password as string, label: c.clientLabel }));
    return {
      filename: "shadowsocks-in.json",
      contentType: "application/json",
      content: JSON.stringify(
        buildXrayInboundShadowsocks({ ...(config as Record<string, unknown>), clients } as never),
        null,
        2
      ),
    };
  }

  supportedSubscriptionFormats() {
    return ["xray_uri", "raw_uri", "singbox_json"] as const;
  }
}
