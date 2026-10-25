import { z } from "zod";
import {
  HostSchema,
  PortSchema,
  formatHostForAuthority,
  transportObject,
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
 * VMess adapter (Xray-core).
 * URI format: vmess://base64(JSON) with the widely-used V2RayN compatibility
 * keys (v, ps, add, port, id, aid, scy, net, type, host, path, tls, sni).
 */

const VmessConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  transport: transportObject.prefault({}),
  // alterId 0 is the modern recommendation (VMess AEAD).
  usersAlterId: z.number().int().min(0).max(65535).default(0),
  cipher: z.enum(["auto", "aes-128-gcm", "chacha20-poly1305", "none"]).default("auto"),
});

export function buildVmessUri(
  uuid: string,
  host: string,
  port: number,
  cipher: string,
  alterId: number,
  transport: {
    network: string;
    security: string;
    path?: string;
    host?: string;
    serviceName?: string;
    tlsSni?: string;
  },
  remark: string
): string {
  const payload = {
    v: "2",
    ps: remark.trim() || "VMess",
    add: formatHostForAuthority(host),
    port: String(port),
    id: uuid,
    aid: String(alterId),
    scy: cipher,
    net: transport.network,
    type: "none", // header obfuscation: none is the only Xray value here
    host: transport.host ?? "",
    path: transport.network === "ws" ? (transport.path ?? "") : (transport.serviceName ?? ""),
    tls: transport.security === "tls" ? "tls" : "none",
    sni: transport.tlsSni ?? "",
  };
  return `vmess://${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
}

export function buildXrayInboundVmess(config: {
  port: number;
  usersAlterId: number;
  cipher: string;
  transport?: Record<string, unknown>;
  clients?: { uuid: string; label?: string }[];
}): Record<string, unknown> {
  const t = (config.transport ?? {}) as {
    network?: string;
    security?: string;
    path?: string;
    host?: string;
    serviceName?: string;
    tlsSni?: string;
    certificateFile?: string;
    keyFile?: string;
  };
  const streamSettings: Record<string, unknown> = {
    network: t.network ?? "tcp",
    security: t.security ?? "none",
  };
  if (t.network === "ws") {
    streamSettings.wsSettings = {
      path: t.path ?? "/",
      headers: t.host ? { Host: t.host } : {},
    };
  }
  if (t.network === "grpc") {
    streamSettings.grpcSettings = { serviceName: t.serviceName ?? "grpc" };
  }
  if (t.security === "tls") {
    streamSettings.tlsSettings = {
      minVersion: "1.2",
      ...(t.certificateFile && t.keyFile
        ? {
            certificates: [{ certificateFile: t.certificateFile, keyFile: t.keyFile }],
          }
        : {}),
    };
  }
  return {
    tag: "vmess-in",
    port: config.port,
    listen: "0.0.0.0",
    protocol: "vmess",
    settings: {
      clients: (config.clients ?? []).map((c) => ({
        id: c.uuid,
        email: c.label,
        alterId: config.usersAlterId,
        level: 0,
      })),
      default: { alterId: config.usersAlterId, level: 0 },
    },
    streamSettings,
  };
}

export class VmessAdapter implements ProtocolAdapter {
  readonly id = "vmess";
  readonly displayName = "VMess";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: true,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "VMess requires an Xray listener on a TCP port. This web-service deployment exposes HTTP(S) " +
        "only and has no xray binary; run Xray externally and manage it from the panel.",
      checks: [{ key: "xray.binary", available: false, reason: "no xray binary in PATH" }],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = VmessConfigSchema.safeParse(config);
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
    const uuid = input.credential.uuid;
    if (!uuid) throw new Error("VMess credential is missing its UUID");
    const t = input.settings as {
      network: string;
      security: string;
      path?: string;
      host?: string;
      serviceName?: string;
      tlsSni?: string;
    };
    const cipher = (input.settings.cipher as string | undefined) ?? "auto";
    const alterId = (input.settings.usersAlterId as number | undefined) ?? 0;
    const uri = buildVmessUri(
      uuid,
      input.serverHost,
      input.serverPort,
      cipher,
      alterId,
      t,
      input.remark
    );
    return {
      content: uri,
      uri,
      compatibleSubscriptionFormats: ["xray_uri", "raw_uri", "singbox_json"],
    };
  }

  async generateSingboxOutbound(input: ClientConfigInput): Promise<Record<string, unknown>> {
    const uuid = input.credential.uuid;
    if (!uuid) throw new Error("VMess credential is missing its UUID");
    const t = input.settings as {
      network?: string;
      security?: string;
      path?: string;
      host?: string;
      serviceName?: string;
      tlsSni?: string;
    };
    const outbound: Record<string, unknown> = {
      type: "vmess",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      uuid,
      security: (input.settings.cipher as string | undefined) ?? "auto",
      alter_id: (input.settings.usersAlterId as number | undefined) ?? 0,
    };
    if (t.network === "ws") {
      outbound.transport = {
        type: "ws",
        path: t.path ?? "/",
        headers: t.host ? { Host: t.host } : undefined,
      };
    } else if (t.network === "grpc") {
      outbound.transport = { type: "grpc", service_name: t.serviceName ?? "grpc" };
    }
    if (t.security === "tls") {
      outbound.tls = {
        enabled: true,
        server_name: t.tlsSni ?? input.serverHost,
        insecure: false,
      };
    }
    return outbound;
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No VMess listener is active in this deployment. Configuration and credentials are managed " +
        "here; run Xray on an externally-hosted server.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const clients = credentials
      .filter((c) => typeof c.secret.uuid === "string")
      .map((c) => ({ uuid: c.secret.uuid as string, label: c.clientLabel }));
    return {
      filename: "vmess-in.json",
      contentType: "application/json",
      content: JSON.stringify(
        buildXrayInboundVmess({ ...(config as Record<string, unknown>), clients } as never),
        null,
        2
      ),
    };
  }

  supportedSubscriptionFormats() {
    return ["xray_uri", "raw_uri", "singbox_json"] as const;
  }
}
