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
 * VLESS adapter (Xray-core).
 *
 * Honest scope in the reference deployment:
 *  - generates and validates VLESS inbounds and client links (vless://),
 *  - is compatible with the xray_uri / singbox_json subscription formats,
 *  - does NOT run VLESS here: no xray binary exists in PaaS web containers,
 *    and the deployment exposes HTTP(S) only. The externally-hosted server
 *    runs Xray with the emitted inbound; the panel is its control plane.
 */

const VlessConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  transport: transportObject.default({}),
  allowTransparent: z.boolean().default(false),
  totalAllowedBytes: z.number().int().nonnegative().optional(),
});

const tlsSupport = (t: { security: string }) => t.security === "tls";

// vless://<uuid>@<host>:<port>?encryption=none&security=<none|tls>&sni=&type=<tcp|ws|grpc>&host=&path=&serviceName=#<remark>
export function buildVlessUri(
  uuid: string,
  host: string,
  port: number,
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
  const params = new URLSearchParams();
  params.set("encryption", "none");
  params.set("security", transport.security);
  if (transport.security === "tls" && transport.tlsSni) params.set("sni", transport.tlsSni);
  params.set("type", transport.network);
  if (transport.network === "ws" && transport.host) params.set("host", transport.host);
  if (transport.network === "ws" && transport.path) params.set("path", transport.path);
  if (transport.network === "grpc" && transport.serviceName)
    params.set("serviceName", transport.serviceName);
  const safeRemark = remark.trim() || "VLESS";
  // URLSearchParams encodes query parts; fragment is appended raw (encoded).
  return `vless://${uuid}@${formatHostForAuthority(host)}:${port}?${params.toString()}#${encodeURIComponent(safeRemark)}`;
}

// Server inbound (Xray JSON) — emitted as full, valid Xray config fragment.
export function buildXrayInboundVless(config: {
  host: string;
  port: number;
  transport: Record<string, unknown>;
  allowTransparent: boolean;
  clients?: { uuid: string; label?: string }[];
}): Record<string, unknown> {
  const t = config.transport as {
    network: string;
    security: string;
    path?: string;
    host?: string;
    serviceName?: string;
    tlsSni?: string;
    certificateFile?: string;
    keyFile?: string;
  };
  const streamSettings: Record<string, unknown> = {
    network: t.network,
    security: t.security,
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
    tag: "vless-in",
    port: config.port,
    listen: "0.0.0.0",
    protocol: "vless",
    settings: {
      clients: (config.clients ?? []).map((c) => ({
        id: c.uuid,
        email: c.label,
        flow: "",
        level: 0,
      })),
      decryption: "none",
      allowTransparent: config.allowTransparent,
    },
    streamSettings,
  };
}

export class VlessAdapter implements ProtocolAdapter {
  readonly id = "vless";
  readonly displayName = "VLESS";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: true,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "VLESS requires an Xray(-core) listener on a TCP port. This single web-service deployment " +
        "(Railway/Render) exposes HTTP(S) only and has no xray binary. Generate and manage configuration; " +
        "run Xray on an external server.",
      checks: [
        { key: "xray.binary", available: false, reason: "no xray binary in PATH" },
        { key: "platform.http_tcp_only", available: true, reason: "HTTP/TCP OK" },
      ],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = VlessConfigSchema.safeParse(config);
    if (!parsed.success) {
      const issues: ZodValidationIssue[] = zodIssues(parsed.error);
      return { valid: false, issues };
    }
    const t = parsed.data.transport as { security: string; network: string };
    if (t.security === "tls" && t.network === "grpc" && !parsed.data.transport.serviceName) {
      return {
        valid: false,
        issues: [{ path: "transport.serviceName", message: "gRPC over TLS requires serviceName" }],
      };
    }
    return {
      valid: true,
      issues: [],
      normalized: parsed.data as unknown as Record<string, unknown>,
    };
  }

  async generateClientConfig(input: ClientConfigInput): Promise<GeneratedConfig> {
    const uuid = input.credential.uuid;
    if (!uuid) throw new Error("VLESS credential is missing its UUID");
    const transport = input.settings as {
      network: string;
      security: string;
      path?: string;
      host?: string;
      serviceName?: string;
      tlsSni?: string;
    };
    const uri = buildVlessUri(uuid, input.serverHost, input.serverPort, transport, input.remark);
    return {
      content: uri,
      uri,
      compatibleSubscriptionFormats: ["xray_uri", "raw_uri", "singbox_json"],
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    // Truthful: no listener is ever started by this deployment.
    return {
      state: "runtime_unavailable",
      explanation:
        "No VLESS listener is active in this deployment. The panel manages configuration and " +
        "credentials; Xray must run on an externally-hosted server (e.g. a VPS).",
    };
  }

  async generateSingboxOutbound(input: ClientConfigInput): Promise<Record<string, unknown>> {
    const uuid = input.credential.uuid;
    if (!uuid) throw new Error("VLESS credential is missing its UUID");
    const t = input.settings as {
      network?: string;
      security?: string;
      path?: string;
      host?: string;
      serviceName?: string;
      tlsSni?: string;
    };
    const outbound: Record<string, unknown> = {
      type: "vless",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      uuid,
      packet_encoding: "xudp",
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

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const clients = credentials
      .filter((c) => typeof c.secret.uuid === "string")
      .map((c) => ({ uuid: c.secret.uuid as string, label: c.clientLabel }));
    const xray = buildXrayInboundVless({
      ...(config as Record<string, unknown>),
      clients,
    } as never);
    return {
      filename: `vless-in.json`,
      contentType: "application/json",
      content: JSON.stringify(xray, null, 2),
    };
  }

  supportedSubscriptionFormats() {
    return ["xray_uri", "raw_uri", "singbox_json"] as const;
  }
}
