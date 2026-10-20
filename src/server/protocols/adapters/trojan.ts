import { z } from "zod";
import {
  HostSchema,
  PortSchema,
  SniSchema,
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
 * Trojan adapter (Xray-core).
 * Trojan mandates TLS. The panel enforces this — a non-TLS Trojan config is a
 * validation error, not a warning.
 */

const TrojanConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  // Trojan requires TLS; sni is recommended but not mandatory.
  tlsSni: SniSchema.optional(),
  certificateFile: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid certificate file path")
    .optional(),
  keyFile: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid private key file path")
    .optional(),
  fallbackTarget: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9.:\-_/]+$/, "fallback must address host:port[/path]")
    .optional(), // where unauthenticated TLS traffic goes (censorship resistance)
});

export function buildTrojanUri(
  password: string,
  host: string,
  port: number,
  sni: string | undefined,
  remark: string
): string {
  const params = new URLSearchParams();
  params.set("security", "tls");
  if (sni) params.set("sni", sni);
  params.set("type", "tcp");
  const safeRemark = remark.trim() || "Trojan";
  return `trojan://${encodeURIComponent(password)}@${formatHostForAuthority(host)}:${port}?${params.toString()}#${encodeURIComponent(safeRemark)}`;
}

export function buildXrayInboundTrojan(config: {
  port: number;
  tlsSni?: string;
  fallbackTarget?: string;
  certificateFile?: string;
  keyFile?: string;
  clients?: { password: string; label?: string }[];
}): Record<string, unknown> {
  const tlsSettings: Record<string, unknown> = { minVersion: "1.2" };
  if (config.certificateFile && config.keyFile) {
    tlsSettings.certificates = [
      { certificateFile: config.certificateFile, keyFile: config.keyFile },
    ];
  }
  const inbound: Record<string, unknown> = {
    tag: "trojan-in",
    port: config.port,
    listen: "0.0.0.0",
    protocol: "trojan",
    settings: {
      clients: (config.clients ?? []).map((c) => ({
        password: c.password,
        email: c.label,
        level: 0,
      })),
      fallbacks: [],
    },
    streamSettings: { network: "tcp", security: "tls", tlsSettings }, // TLS mandatory
  };
  if (config.fallbackTarget) {
    (inbound.settings as Record<string, unknown>).fallbacks = [{ dest: config.fallbackTarget }];
  }
  return inbound;
}

export class TrojanAdapter implements ProtocolAdapter {
  readonly id = "trojan";
  readonly displayName = "Trojan";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: true,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "Trojan requires a TLS-terminating listener (Xray or trojan-golang). This deployment exposes " +
        "HTTP(S) only; run Trojan externally and manage it from the panel.",
      checks: [{ key: "xray.binary", available: false, reason: "no xray binary in PATH" }],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = TrojanConfigSchema.safeParse(config);
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
    if (!password) throw new Error("Trojan credential is missing its password");
    const uri = buildTrojanUri(
      password,
      input.serverHost,
      input.serverPort,
      input.settings.tlsSni as string | undefined,
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
    if (!password) throw new Error("Trojan credential is missing its password");
    return {
      type: "trojan",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      password,
      tls: {
        enabled: true,
        server_name: (input.settings.tlsSni as string | undefined) ?? input.serverHost,
        insecure: false,
      },
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No Trojan listener is active in this deployment. Configuration and credentials are managed " +
        "here; run Trojan on an externally-hosted TLS front (Xray, trojan-go, etc.).",
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
      filename: "trojan-in.json",
      contentType: "application/json",
      content: JSON.stringify(
        buildXrayInboundTrojan({ ...(config as Record<string, unknown>), clients } as never),
        null,
        2
      ),
    };
  }

  supportedSubscriptionFormats() {
    return ["xray_uri", "raw_uri", "singbox_json"] as const;
  }
}
