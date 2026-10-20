import { z } from "zod";
import { zodIssues, type ZodValidationIssue } from "../primitives.js";
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
 * OpenVPN adapter.
 *
 * Honest scope: OpenVPN needs a tun/tap device and typically root; it is
 * externally hosted here. The panel imports and validates client .ovpn
 * profiles, seals per-client username/password credentials, and exports a
 * profile template. It never claims a tunnel exists.
 *
 * Imported profiles are untrusted input. Directives that can execute local
 * programs or open management channels are rejected before storage.
 */

const OvpnRemoteLine = /^remote\s+([a-zA-Z0-9.\-:]+)\s+(\d{1,5})\s*(udp4?|tcp4?|udp6?|tcp6?)?$/;
const DANGEROUS_DIRECTIVES =
  /^(script-security|up|down|route-up|route-pre-down|ipchange|plugin|management|management-client|management-hold|client-connect|client-disconnect|learn-address|auth-user-pass-verify|tls-verify|engine|providers|askpass|auth-user-pass-verify)\b/i;

/** Structural validation of an .ovpn profile (static parse, no execution). */
export function validateOvpnProfile(text: string): {
  valid: boolean;
  issues: string[];
  remote: { host: string; port: number; proto: string } | null;
} {
  const issues: string[] = [];
  const lines = text.split(/\r?\n/);
  let hasRemote = false;
  let remote: { host: string; port: number; proto: string } | null = null;
  let inTlsAuth = false;
  let tlsAuthLines = 0;
  let caCount = 0;
  let keyCount = 0;
  let inlineAuthOpen = false;
  let currentBlock: string | null = null;
  const blocks = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    const open = /^<([a-z0-9-]+)>$/i.exec(line);
    if (open) {
      currentBlock = open[1]?.toLowerCase() ?? null;
      if (currentBlock) blocks.add(currentBlock);
      if (currentBlock === "auth-user-pass") inlineAuthOpen = true;
      if (currentBlock === "tls-auth" || currentBlock === "tls-crypt") inTlsAuth = true;
      if (currentBlock === "ca") caCount++;
      if (currentBlock === "key") keyCount++;
      continue;
    }
    const close = /^<\/([a-z0-9-]+)>$/i.exec(line);
    if (close) {
      const closing = close[1]?.toLowerCase();
      if (closing === "auth-user-pass") inlineAuthOpen = false;
      if (closing === "tls-auth" || closing === "tls-crypt") inTlsAuth = false;
      currentBlock = null;
      continue;
    }
    if (inTlsAuth) {
      if (!/^[A-Za-z0-9+/=\s]*$/.test(line)) {
        issues.push("tls-auth/tls-crypt block contains invalid characters");
      }
      tlsAuthLines++;
      continue;
    }
    if (currentBlock === "auth-user-pass") {
      continue;
    }
    if (line.startsWith("#") || line.startsWith(";") || line === "") continue;
    if (DANGEROUS_DIRECTIVES.test(line)) {
      issues.push(`profile contains a forbidden executable directive: ${line.split(/\s+/)[0]}`);
    }
    if (line === "client" && !lines.some((l) => l.trim() === "client")) {
      // never reached; kept for clarity
    }
    if (/^remote\b/.test(line)) {
      const m = OvpnRemoteLine.exec(line);
      if (m && m[1] && m[2]) {
        const p = Number(m[2]);
        if (p >= 1 && p <= 65535) {
          hasRemote = true;
          remote = { host: m[1], port: p, proto: m[3] ?? "udp" };
        }
      }
      if (!m) issues.push("remote line is malformed or uses an unsupported address");
    }
    if (/^(ca\s+\S)/.test(line)) caCount++;
    if (/^(key\s+\S)/.test(line)) keyCount++;
  }

  if (!hasRemote || !remote) issues.push("profile has no valid `remote host port` line");
  if (caCount === 0) issues.push("profile embeds no CA certificate");
  if (keyCount > 1) issues.push("profile embeds multiple private keys");
  if (tlsAuthLines > 0 && tlsAuthLines < 4) issues.push("tls-auth/tls-crypt block seems truncated");
  if (inlineAuthOpen) issues.push("auth-user-pass block is not closed");
  void blocks;
  return { valid: issues.length === 0, issues, remote };
}

export const OvpnImportSchema = z.object({
  profileText: z.string().min(10).max(200_000),
  label: z.string().min(1).max(64),
  remoteHost: z.string().max(253).optional(),
});

const OvpnConfigSchema = z.object({
  profileText: z.string().min(10).max(200_000),
  label: z.string().min(1).max(64),
  host: z.string().min(1).max(253).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  remoteHost: z.string().max(253).optional(),
});

function stripAuthUserPass(profile: string): string {
  return profile
    .replace(/^\s*auth-user-pass(?:\s+\S+)?\s*$/gm, "")
    .replace(/<auth-user-pass>[\s\S]*?<\/auth-user-pass>/gi, "");
}

function injectInlineAuth(profile: string, username: string, password: string): string {
  const sanitizedUser = username.replace(/[\r\n<>]/g, "");
  const sanitizedPass = password.replace(/[\r\n<>]/g, "");
  return (
    stripAuthUserPass(profile).trimEnd() +
    `\n<auth-user-pass>\n${sanitizedUser}\n${sanitizedPass}\n</auth-user-pass>\n`
  );
}

export class OpenvpnAdapter implements ProtocolAdapter {
  readonly id = "openvpn";
  readonly displayName = "OpenVPN";

  async detectCapabilities(): Promise<ProtocolCapabilities> {
    return {
      canGenerateConfiguration: true,
      canGenerateClientUri: false,
      canHostInProcess: false,
      requiresExternalServer: true,
      reason:
        "OpenVPN requires tun/tap kernel devices and commonly root. PaaS web containers provide " +
        "neither. Host OpenVPN externally; the panel imports, validates, stores and distributes " +
        "profiles and credentials.",
      checks: [{ key: "openvpn.binary", available: false, reason: "no openvpn binary in PATH" }],
    };
  }

  async validateConfig(input: unknown): Promise<ValidationResult> {
    const parsed = OvpnConfigSchema.safeParse(input);
    if (!parsed.success) return { valid: false, issues: zodIssues(parsed.error) };
    const check = validateOvpnProfile(parsed.data.profileText);
    if (!check.valid || !check.remote) {
      return {
        valid: false,
        issues: check.issues.map((message, index) => ({
          path: `profileText[#${index}]`,
          message,
        })),
      };
    }
    return {
      valid: true,
      issues: [],
      normalized: {
        ...parsed.data,
        host: parsed.data.host ?? check.remote.host,
        port: parsed.data.port ?? check.remote.port,
        remoteHost: check.remote.host,
      },
    };
  }

  async generateClientConfig(input: ClientConfigInput): Promise<GeneratedConfig> {
    const profile = input.settings.profileText;
    if (typeof profile !== "string") throw new Error("OpenVPN profile is missing");
    const check = validateOvpnProfile(profile);
    if (!check.valid) throw new Error("stored OpenVPN profile failed validation");
    const username = input.credential.username;
    const password = input.credential.password;
    if (!username || !password) throw new Error("OpenVPN credential is incomplete");
    return {
      content: injectInlineAuth(profile, username, password),
      compatibleSubscriptionFormats: [], // .ovpn files cannot ride URI subscriptions
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return {
      state: "runtime_unavailable",
      explanation:
        "No OpenVPN daemon is active in this deployment (no tun device, no root, HTTP(S) ingress only). " +
        "Manage profiles and credentials here; run OpenVPN on an externally-hosted server.",
    };
  }

  exportConfig(
    config: Record<string, unknown>,
    _schemaVersion: string,
    _credentials: readonly ExportCredential[] = []
  ): ExportResult {
    const profile = typeof config.profileText === "string" ? config.profileText : "";
    return {
      filename: "openvpn-client-template.ovpn",
      contentType: "application/x-openvpn-profile",
      content:
        "# PanahGozar: client credentials are delivered per assignment.\n" +
        "# This download is the validated profile template only.\n" +
        profile,
    };
  }

  supportedSubscriptionFormats() {
    return [] as const;
  }
}

export { OvpnConfigSchema };
