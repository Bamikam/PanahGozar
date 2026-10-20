import { z } from "zod";
import { parseSafeJson } from "./primitives.js";

/**
 * sing-box configuration import/export (strict).
 * Reference: https://sing-box.sagernet.org/configuration/
 * sing-box is a configuration *ecosystem*, not a protocol — imports map only
 * its server/outbound types into compatible panel protocols.
 */

export const SINGBOX_SCHEMA_VERSION = "1";

export const SINGBOX_SUPPORTED_OUTBOUND_TYPES = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "socks",
  "http",
] as const;

const SingboxOutboundShape = z.object({
  type: z.string().max(32),
  tag: z.string().max(64).optional(),
  server: z.string().max(253).optional(),
  server_port: z.coerce.number().int().min(1).max(65535).optional(),
  uuid: z.string().max(64).optional(),
  password: z.string().max(128).optional(),
  method: z.string().max(64).optional(),
  tls: z.record(z.string(), z.unknown()).optional(),
  transport: z.record(z.string(), z.unknown()).optional(),
});

const SingboxDocumentShape = z.object({
  log: z.record(z.string(), z.unknown()).optional(),
  inbounds: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
  outbounds: z.array(SingboxOutboundShape).max(64).default([]),
  route: z.record(z.string(), z.unknown()).optional(),
});

export interface SingboxOutboundRecord {
  type: string;
  tag: string | null;
  server: string | null;
  serverPort: number | null;
  raw: Record<string, unknown>;
}

export interface SingboxImportResult {
  ok: boolean;
  issues: string[];
  outbounds: SingboxOutboundRecord[];
}

export function importSingboxConfig(input: unknown): SingboxImportResult {
  const parsedText = parseSafeJson(input);
  if (!parsedText.ok) return { ok: false, issues: [parsedText.error], outbounds: [] };
  const doc = SingboxDocumentShape.safeParse(parsedText.value);
  if (!doc.success) {
    return {
      ok: false,
      issues: doc.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      outbounds: [],
    };
  }
  const issues: string[] = [];
  const outbounds: SingboxOutboundRecord[] = [];
  for (const ob of doc.data.outbounds) {
    if (!(SINGBOX_SUPPORTED_OUTBOUND_TYPES as readonly string[]).includes(ob.type as never)) {
      issues.push(`outbound "${ob.tag ?? ob.type}" type "${ob.type}" unsupported — skipped`);
      continue;
    }
    outbounds.push({
      type: ob.type,
      tag: ob.tag ?? null,
      server: ob.server ?? null,
      serverPort: ob.server_port ?? null,
      raw: ob as unknown as Record<string, unknown>,
    });
  }
  return { ok: issues.length === 0, issues, outbounds };
}

/** Minimal valid client-side sing-box doc built from a panel configuration. */
export function newSingboxClientSkeleton(
  outbound: Record<string, unknown>
): Record<string, unknown> {
  return {
    log: { level: "warn" },
    inbounds: [{ type: "mixed", tag: "mixed", listen: "127.0.0.1", listen_port: 2080 }],
    outbounds: [outbound, { type: "direct", tag: "direct" }],
    route: { final: outbound.tag ?? "proxy", rules: [] },
    experimental: { cache_file: { enabled: false } },
  };
}
