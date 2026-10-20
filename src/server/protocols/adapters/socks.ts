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
 * SOCKS5 adapter.
 *
 * SOCKS5 (RFC 1928) is special: in *this deployment* the panel could in
 * principle implement a minimal in-process SOCKS5 listener (pure Node TCP),
 * but PaaS web services forward only HTTP(S) traffic, and the master switch
 * defaults to off. The adapter therefore manages credentials/configuration
 * and reports runtime_unavailable unless ENABLE_RUNTIME_LISTENERS is enabled
 * AND the platform somehow forwards raw TCP — which Railway/Render do not.
 * Empirical truth: no listener is claimed without an actual bind + probe.
 */

const SocksConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  bindAddress: z.string().max(64).default("0.0.0.0"),
  udpAssociate: z.boolean().default(false),
  username: z.string().max(64).optional(),
});

export class SocksAdapter implements ProtocolAdapter {
  readonly id = "socks";
  readonly displayName = "SOCKS5";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: false, // no standardized client URI for SOCKS5
      canHostInProcess: false, // would need raw TCP forwarding; not available here
      requiresExternalServer: true,
      reason:
        "SOCKS5 needs a raw TCP (and optionally UDP) listener. PaaS platforms forward only HTTP(S), " +
        "so it must run externally. The panel manages users and settings.",
      checks: [
        { key: "platform.http_tcp_only", available: true, reason: "HTTP(S) OK" },
        { key: "socks.raw_tcp", available: false, reason: "raw TCP forwarding unavailable" },
      ],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = SocksConfigSchema.safeParse(config);
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
    // Best-effort standard representation accepted by many clients:
    // socks://username:password@host:port#remark  (not a formal RFC but common)
    const user = input.credential.username ?? "";
    const pass = input.credential.password ?? "";
    if (!user || !pass) throw new Error("SOCKS5 credential is incomplete");
    const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    const uri = `socks://${auth}${formatHostForAuthority(input.serverHost)}:${input.serverPort}#${encodeURIComponent(input.remark || "SOCKS5")}`;
    return {
      content: uri,
      uri,
      compatibleSubscriptionFormats: ["raw_uri", "singbox_json"],
    };
  }

  async generateSingboxOutbound(input: ClientConfigInput): Promise<Record<string, unknown>> {
    const username = input.credential.username;
    const password = input.credential.password;
    if (!username || !password) throw new Error("SOCKS5 credential is incomplete");
    return {
      type: "socks",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      version: "5",
      username,
      password,
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No SOCKS5 listener is active. Run the SOCKS5 daemon on an externally-hosted server with " +
        "the credentials produced here.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const accounts = credentials
      .filter((c) => typeof c.secret.username === "string" && typeof c.secret.password === "string")
      .map((c) => ({
        user: c.secret.username as string,
        pass: c.secret.password as string,
      }));
    const exportable = {
      tag: "socks-in",
      port: (config as { port: number }).port,
      listen: (config as { bindAddress?: string }).bindAddress ?? "0.0.0.0",
      protocol: "socks",
      settings: {
        auth: accounts.length > 0 ? "password" : "noauth",
        accounts,
        udp: Boolean((config as { udpAssociate?: boolean }).udpAssociate),
      },
    };
    return {
      filename: "socks-in.json",
      contentType: "application/json",
      content: JSON.stringify(exportable, null, 2),
    };
  }

  supportedSubscriptionFormats() {
    return ["raw_uri", "singbox_json"] as const;
  }
}
