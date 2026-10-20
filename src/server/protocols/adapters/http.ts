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
 * HTTP proxy adapter (plain HTTP). HTTPS proxying is expressible as
 * HTTP CONNECT over TLS by the upstream implementation; the panel exposes
 * a `upstreamTls` switch, exported to Xray's http inbound accordingly.
 */

const HttpConfigSchema = z
  .object({
    host: HostSchema,
    port: PortSchema,
    bindAddress: z.string().max(64).default("0.0.0.0"),
    allowConnect: z.boolean().default(true),
    connectDomains: z.array(z.string().max(120)).max(100).default([]), // [] = allow all
    timeoutSeconds: z.number().int().min(30).max(3600).default(300),
    username: z.string().max(64).optional(),
    // TLS-wrapped HTTP proxy listener. Certificate files stay on the external
    // server; the panel only records their absolute paths for export.
    tls: z.boolean().default(false),
    certificateFile: z
      .string()
      .max(300)
      .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid certificate path")
      .optional(),
    keyFile: z
      .string()
      .max(300)
      .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid key path")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.tls && !value.certificateFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["certificateFile"],
        message: "certificateFile is required for a TLS-wrapped HTTP proxy",
      });
    }
    if (value.tls && !value.keyFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyFile"],
        message: "keyFile is required for a TLS-wrapped HTTP proxy",
      });
    }
  });

export class HttpAdapter implements ProtocolAdapter {
  readonly id = "http";
  readonly displayName = "HTTP Proxy";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: false, // no standardized HTTP-proxy client URI
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "An HTTP proxy needs a raw TCP listener and forward-proxy semantics. PaaS web services forward " +
        "HTTP(S) but terminate TLS before the app, so a *plain* HTTP proxy port must be exposed by an " +
        "external server for arbitrary proxying. Panel manages users/settings.",
      checks: [{ key: "http.raw_tcp", available: false, reason: "raw TCP forwarding unavailable" }],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = HttpConfigSchema.safeParse(config);
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
    const user = input.credential.username ?? "";
    const pass = input.credential.password ?? "";
    if (!user || !pass) throw new Error("HTTP proxy credential is incomplete");
    const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    const scheme = input.settings.tls === true ? "https" : "http";
    const uri = `${scheme}://${auth}${formatHostForAuthority(input.serverHost)}:${input.serverPort}#${encodeURIComponent(input.remark || "HTTP")}`;
    return {
      content: uri,
      uri,
      compatibleSubscriptionFormats: ["raw_uri", "singbox_json"],
    };
  }

  async generateSingboxOutbound(input: ClientConfigInput): Promise<Record<string, unknown>> {
    const username = input.credential.username;
    const password = input.credential.password;
    if (!username || !password) throw new Error("HTTP proxy credential is incomplete");
    const outbound: Record<string, unknown> = {
      type: "http",
      tag: "proxy",
      server: input.serverHost,
      server_port: input.serverPort,
      username,
      password,
    };
    if (input.settings.tls === true) {
      outbound.tls = {
        enabled: true,
        server_name: input.serverHost,
        insecure: false,
      };
    }
    return outbound;
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No HTTP proxy listener is active. Run the forward proxy on an externally-hosted server with " +
        "the credentials produced here.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const c = config as {
      port: number;
      bindAddress?: string;
      allowConnect?: boolean;
      timeoutSeconds?: number;
      tls?: boolean;
      certificateFile?: string;
      keyFile?: string;
    };
    const accounts = credentials
      .filter(
        (cred) =>
          typeof cred.secret.username === "string" && typeof cred.secret.password === "string"
      )
      .map((cred) => ({
        user: cred.secret.username as string,
        pass: cred.secret.password as string,
      }));
    const streamSettings = c.tls
      ? {
          network: "tcp",
          security: "tls",
          tlsSettings: {
            certificates: [{ certificateFile: c.certificateFile, keyFile: c.keyFile }],
          },
        }
      : { network: "tcp", security: "none" };
    return {
      filename: c.tls ? "https-in.json" : "http-in.json",
      contentType: "application/json",
      content: JSON.stringify(
        {
          tag: c.tls ? "https-in" : "http-in",
          port: c.port,
          listen: c.bindAddress ?? "0.0.0.0",
          protocol: "http",
          settings: {
            auth: accounts.length > 0 ? "password" : "noauth",
            accounts,
            timeout: c.timeoutSeconds ?? 300,
            allowTransparent: false,
          },
          streamSettings,
        },
        null,
        2
      ),
    };
  }

  supportedSubscriptionFormats() {
    return ["raw_uri", "singbox_json"] as const;
  }
}
