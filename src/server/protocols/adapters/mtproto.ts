import { z } from "zod";
import { HostSchema, PortSchema, zodIssues, type ZodValidationIssue } from "../primitives.js";
import type {
  ProtocolAdapter,
  ValidationResult,
  ProtocolCapabilities,
  ClientConfigInput,
  GeneratedConfig,
  RuntimeStatus,
  ExportResult,
} from "../types.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Telegram MTProto proxy adapter.
 *
 * Honest scope: MTProto proxy servers (seriyps/mtproto_proxy, MTProxy etc.)
 * require a dedicated TCP listener on port 443 (or similar) plus shared
 * routing. This deployment exposes HTTP(S) only, so runtime is
 * "externally hosted". The panel:
 *   - stores & redacts the proxy secret (CSPRNG-generated),
 *   - renders tg://proxy / https://t.me/proxy links when the admin supplies
 *     the externally-hosted address,
 *   - validates/exported server configuration snippets,
 *   - never claims listener health without a real recorded check.
 */

const MtprotoConfigSchema = z.object({
  host: HostSchema, // externally-hosted proxy address
  port: PortSchema.default(443),
  // Tag obtained from @MTProxybot for advertising/promo-less mode (preferred).
  adTag: z
    .string()
    .max(40)
    .regex(/^([a-fA-F0-9]{32})?$/, "tag must be 32 hex characters")
    .optional(),
  preferredTransport: z.enum(["port", "range", "domain"]).default("port"),
});

export function buildTgLink(
  secret: string,
  host: string,
  port: number,
  remark: string
): { tgUri: string; httpsUri: string } {
  // Telegram proxy share links:
  //   tg://proxy?server=HOST&port=PORT&secret=SECRET&user? (user optional)
  //   https://t.me/proxy?server=HOST&port=PORT&secret=SECRET
  const qs = new URLSearchParams({ server: host, port: String(port), secret });
  const label = remark.trim();
  const tgUri = `tg://proxy?${qs.toString()}`;
  const httpsUri = label
    ? `https://t.me/proxy?${qs.toString()}`
    : `https://t.me/proxy?${qs.toString()}`;
  return { tgUri, httpsUri };
}

export function buildErlangMtprotoConfig(config: { port: number; adTag?: string }): string {
  // seriyps/mtproto_proxy style snippet (documented format, not invented).
  // The real per-client secret lives in the sealed credential store and is
  // delivered through tg:// links; it is deliberately not templated here.
  const lines = [
    "# PanahGozar-generated MTProto proxy settings (erlang mtproto_proxy)",
    "# Replace SECRET_FROM_PANEL with a client secret from the panel export.",
    `{ mtproto_proxy, [`,
    `  {port, [${config.port}]},`,
    `  {secret, ["SECRET_FROM_PANEL"]},`,
    config.adTag ? `  {ad_tag, <<"${config.adTag}">>},` : "",
    `]}.`,
  ];
  return lines.filter(Boolean).join("\n") + "\n";
}

export class MtprotoAdapter implements ProtocolAdapter {
  readonly id = "mtproto";
  readonly displayName = "Telegram MTProto Proxy";

  constructor(private db: PrismaClient) {}

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: true,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "MTProto proxy requires a dedicated raw TCP listener (typically port 443). This deployment " +
        "forwards HTTP(S) only, so the proxy must run externally (e.g. on a VPS). The panel manages " +
        "secrets, tags, and share links.",
      checks: [{ key: "mtproto.binary", available: false, reason: "no MTProxy binary in PATH" }],
    };
  }

  async validateConfig(config: unknown): Promise<ValidationResult> {
    const parsed = MtprotoConfigSchema.safeParse(config);
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
    const secret = input.credential.secret;
    if (!secret || !/^(dd)?[0-9a-fA-F]{32}$/.test(secret)) {
      throw new Error("MTProto credential is missing a valid secret");
    }
    const { tgUri } = buildTgLink(secret, input.serverHost, input.serverPort, input.remark);
    return {
      content: tgUri,
      uri: tgUri,
      compatibleSubscriptionFormats: ["raw_uri"],
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No MTProto proxy listener is active here. Host erlang-mtproto-proxy or MTProxy externally; " +
        "the panel stores the secret and provides share links and configuration snippets.",
    };
  }

  exportConfig(config: Record<string, unknown>, _schemaVersion: string): ExportResult {
    return {
      filename: "mtproto-proxy-config.config",
      contentType: "text/plain",
      content: buildErlangMtprotoConfig(config as never),
    };
  }

  supportedSubscriptionFormats() {
    return ["raw_uri"] as const;
  }
}
