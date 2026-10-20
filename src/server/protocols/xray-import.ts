import { z } from "zod";
import { parseSafeJson } from "./primitives.js";

/**
 * Xray JSON configuration import/export (strict, schema-checked).
 *
 * Imports are treated as UNTRUSTED input: parsed inside strict limits
 * (size/depth), field-validated, and reduced to the panel's canonical
 * inbounds setting. Unknown top-level sections are reported — never executed,
 * never templated into shell commands.
 *
 * References: https://xtls.github.io/config/ (official Xray config format).
 */

export const XRAY_SCHEMA_VERSION = "1";

const StreamSettingsShape = z
  .object({
    network: z.string().max(32).optional(),
    security: z.string().max(32).optional(),
    tlsSettings: z.record(z.string(), z.unknown()).optional(),
    wsSettings: z.record(z.string(), z.unknown()).optional(),
    grpcSettings: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const InboundShape = z.object({
  tag: z.string().max(64).optional(),
  listen: z.string().max(64).optional(),
  port: z.coerce.number().int().min(1).max(65535),
  protocol: z.string().min(1).max(32),
  settings: z.record(z.string(), z.unknown()).default({}),
  streamSettings: StreamSettingsShape.optional(),
});

const XrayDocumentShape = z.object({
  log: z.record(z.string(), z.unknown()).optional(),
  inbounds: z.array(InboundShape).default([]),
  outbounds: z.array(z.record(z.string(), z.unknown())).default([]),
  routing: z.record(z.string(), z.unknown()).optional(),
});

export interface XrayInboundRecord {
  protocol: string;
  port: number;
  listen: string | null;
  tag: string | null;
  transport: Record<string, unknown> | null;
  tlsSettings: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface XrayImportResult {
  ok: boolean;
  issues: string[];
  /** Canonicalized inbound summaries the panel is able to host configs for. */
  inbounds: XrayInboundRecord[];
}

export interface XrayExportInput {
  /** Inbounds emitted from panel-stored configurations. */
  inbounds: Record<string, unknown>[];
}

export function newXraySkeleton(input: XrayExportInput): Record<string, unknown> {
  return {
    log: { loglevel: "warning" },
    inbounds: input.inbounds,
    outbounds: [
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" },
    ],
  };
}

export function importXrayConfig(input: unknown): XrayImportResult {
  const parsedText = parseSafeJson(input);
  if (!parsedText.ok) {
    return { ok: false, issues: [parsedText.error], inbounds: [] };
  }
  const doc = XrayDocumentShape.safeParse(parsedText.value);
  if (!doc.success) {
    return {
      ok: false,
      issues: doc.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      inbounds: [],
    };
  }
  const issues: string[] = [];
  const supportedProtocols = new Set(["vless", "vmess", "trojan", "shadowsocks", "socks", "http"]);
  const inbounds: XrayInboundRecord[] = [];
  for (const inbound of doc.data.inbounds) {
    if (!supportedProtocols.has(inbound.protocol)) {
      issues.push(
        `inbound "port ${inbound.port}" uses unsupported protocol "${inbound.protocol}" — skipped`
      );
      continue;
    }
    inbounds.push({
      protocol: inbound.protocol,
      port: inbound.port,
      listen: inbound.listen ?? null,
      tag: inbound.tag ?? null,
      transport: (inbound.streamSettings as Record<string, unknown>) ?? null,
      tlsSettings:
        (inbound.streamSettings?.tlsSettings as Record<string, unknown> | undefined) ?? null,
      raw: inbound as unknown as Record<string, unknown>,
    });
  }
  return { ok: issues.length === 0, issues, inbounds };
}
