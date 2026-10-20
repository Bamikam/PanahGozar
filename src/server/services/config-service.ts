import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppConfig } from "../env-types.js";
import type { ProtocolRegistry } from "../protocols/registry.js";
import type { ExportCredential, ExportResult, ValidationResult } from "../protocols/types.js";
import { zodIssues, type ZodValidationIssue, parseSafeJson } from "../protocols/primitives.js";
import { open } from "../security/sealed-store.js";
import { newXraySkeleton, importXrayConfig } from "../protocols/xray-import.js";
import { importSingboxConfig } from "../protocols/singbox-import.js";
import { catalogEntry } from "../protocols/catalog.js";
import { ensureWireGuardServerKey, readWireGuardServerKey } from "../protocols/wireguard-keys.js";
import type { ConfigurationDTO } from "../../shared/types.js";

const ConfigurationFields = z.object({
  protocolId: z.string().min(2).max(32),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((v) => !/[<>{}]/.test(v), "name may not contain <, >, {, or }"),
  config: z.record(z.string(), z.unknown()),
  notes: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().default(true),
});

const ConfigurationUpdateFields = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => !/[<>{}]/.test(v), "name may not contain <, >, {, or }"),
    config: z.record(z.string(), z.unknown()),
    notes: z.string().max(2000).nullable(),
    isActive: z.boolean(),
    changeNote: z.string().max(500).optional(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "no changes requested");

export interface ConfigurationDTOFull extends ConfigurationDTO {
  protocolName: string;
  config: Record<string, unknown>;
}

function parseOrIssue<T>(
  schema: z.ZodType<T>,
  input: unknown
): { ok: true; data: T } | { ok: false; issues: ZodValidationIssue[] } {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

function contentLooksLikeXrayInbound(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.protocol === "string" && typeof parsed.port === "number";
  } catch {
    return false;
  }
}

/** Maps common Xray streamSettings into our transport schema. */
function mapXrayTransport(stream: Record<string, unknown> | null): Record<string, unknown> {
  if (!stream) return {};
  const network = typeof stream.network === "string" ? stream.network : "tcp";
  const security = typeof stream.security === "string" ? stream.security : "none";
  const ws = stream.wsSettings as Record<string, unknown> | undefined;
  const grpc = stream.grpcSettings as Record<string, unknown> | undefined;
  const tls = stream.tlsSettings as Record<string, unknown> | undefined;
  const headerHost =
    ws?.headers && typeof ws.headers === "object"
      ? (ws.headers as Record<string, unknown>).Host
      : undefined;
  return {
    network: ["tcp", "ws", "grpc"].includes(network) ? network : "tcp",
    security: security === "tls" ? "tls" : "none",
    path: typeof ws?.path === "string" ? ws.path : undefined,
    host: typeof headerHost === "string" ? headerHost : undefined,
    serviceName: typeof grpc?.serviceName === "string" ? grpc.serviceName : undefined,
    tlsSni: typeof tls?.serverName === "string" ? tls.serverName : undefined,
  };
}

export class ConfigService {
  constructor(
    private db: PrismaClient,
    private cfg: AppConfig,
    private registry: ProtocolRegistry
  ) {}

  private async ensureProtocolRow(tx: Prisma.TransactionClient, protocolId: string): Promise<void> {
    const meta = catalogEntry(protocolId);
    if (!meta) throw Object.assign(new Error("unknown protocol"), { statusCode: 400 });
    await tx.protocol.upsert({
      where: { id: meta.id },
      update: {
        displayName: meta.displayName,
        category: meta.category,
        deploymentMode: meta.deploymentMode,
        requiresInboundTcp: meta.requiresInboundTcp,
        requiresUdp: meta.requiresUdp,
        requiresRoot: meta.requiresRoot,
        docsUrl: meta.docsUrl,
      },
      create: {
        id: meta.id,
        displayName: meta.displayName,
        category: meta.category,
        deploymentMode: meta.deploymentMode,
        requiresInboundTcp: meta.requiresInboundTcp,
        requiresUdp: meta.requiresUdp,
        requiresRoot: meta.requiresRoot,
        docsUrl: meta.docsUrl,
      },
    });
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    configurationId: string,
    config: object,
    schemaVersion: string,
    changeNote: string,
    source: string,
    actorId: string
  ): Promise<number> {
    const last = await tx.configurationVersion.findFirst({
      where: { configurationId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const versionNumber = (last?.versionNumber ?? 0) + 1;
    await tx.configurationVersion.create({
      data: {
        configurationId,
        versionNumber,
        config: config as Prisma.InputJsonValue,
        schemaVersion,
        changeNote,
        source,
        createdById: actorId || null,
      },
    });
    return versionNumber;
  }

  private async prepareConfig(
    tx: Prisma.TransactionClient,
    protocolId: string,
    configurationId: string,
    config: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (protocolId !== "wireguard") return config;
    const provisioned = await ensureWireGuardServerKey(tx, this.cfg, configurationId, config);
    return provisioned.config;
  }

  async create(
    input: unknown,
    actorId: string
  ): Promise<{ ok: boolean; issues: ZodValidationIssue[]; value?: ConfigurationDTOFull }> {
    const parsed = parseOrIssue(ConfigurationFields, input);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const data = parsed.data;
    const adapter = this.registry.get(data.protocolId);
    if (!adapter) {
      return {
        ok: false,
        issues: [{ path: "protocolId", message: `unknown protocol: ${data.protocolId}` }],
      };
    }
    const validation = await adapter.validateConfig(data.config);
    if (!validation.valid || !validation.normalized) {
      return { ok: false, issues: validation.issues };
    }
    const duplicate = await this.db.protocolConfiguration.findUnique({
      where: { protocolId_name: { protocolId: data.protocolId, name: data.name } },
    });
    if (duplicate && !duplicate.deletedAt) {
      return {
        ok: false,
        issues: [
          {
            path: "name",
            message: "a configuration with this name already exists for this protocol",
          },
        ],
      };
    }

    try {
      const created = await this.db.$transaction(async (tx) => {
        await this.ensureProtocolRow(tx, data.protocolId);
        let row = duplicate?.deletedAt
          ? await tx.protocolConfiguration.update({
              where: { id: duplicate.id },
              data: {
                config: validation.normalized as Prisma.InputJsonValue,
                deletedAt: null,
                isActive: data.isActive,
                notes: data.notes ?? null,
              },
            })
          : await tx.protocolConfiguration.create({
              data: {
                protocolId: data.protocolId,
                name: data.name,
                schemaVersion: "1",
                config: validation.normalized as Prisma.InputJsonValue,
                isActive: data.isActive,
                notes: data.notes ?? null,
              },
            });
        const finalConfig = await this.prepareConfig(
          tx,
          data.protocolId,
          row.id,
          validation.normalized!
        );
        if (data.protocolId === "wireguard") {
          row = await tx.protocolConfiguration.update({
            where: { id: row.id },
            data: { config: finalConfig as Prisma.InputJsonValue },
          });
        }
        const version = await this.writeVersion(
          tx,
          row.id,
          finalConfig,
          row.schemaVersion,
          "created",
          "panel",
          actorId
        );
        return { row, version };
      });
      return { ok: true, issues: [], value: this.toDTO(created.row, created.version) };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return {
          ok: false,
          issues: [{ path: "name", message: "configuration name already exists" }],
        };
      }
      throw err;
    }
  }

  /** Validate a candidate without storing it (preview endpoint). */
  async validatePreview(protocolId: string, config: unknown): Promise<ValidationResult> {
    const adapter = this.registry.get(protocolId);
    if (!adapter) {
      return { valid: false, issues: [{ path: "protocolId", message: "unknown protocol" }] };
    }
    return adapter.validateConfig(config);
  }

  async update(
    id: string,
    input: unknown,
    actorId: string
  ): Promise<{ ok: boolean; issues: ZodValidationIssue[]; value?: ConfigurationDTOFull }> {
    const parsed = parseOrIssue(ConfigurationUpdateFields, input);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const existing = await this.db.protocolConfiguration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing)
      return { ok: false, issues: [{ path: "id", message: "configuration not found" }] };
    const adapter = this.registry.require(existing.protocolId);

    let normalized: Record<string, unknown> | undefined;
    if (parsed.data.config !== undefined) {
      const result = await adapter.validateConfig(parsed.data.config);
      if (!result.valid || !result.normalized) return { ok: false, issues: result.issues };
      normalized = result.normalized;
    }

    try {
      const result = await this.db.$transaction(async (tx) => {
        if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
          const duplicate = await tx.protocolConfiguration.findUnique({
            where: {
              protocolId_name: { protocolId: existing.protocolId, name: parsed.data.name },
            },
          });
          if (duplicate && duplicate.id !== id) {
            throw Object.assign(new Error("a configuration with this name already exists"), {
              statusCode: 409,
            });
          }
        }
        let config = (normalized ?? (existing.config as Record<string, unknown>)) as Record<
          string,
          unknown
        >;
        if (parsed.data.config !== undefined) {
          config = await this.prepareConfig(tx, existing.protocolId, id, config);
        }
        const row = await tx.protocolConfiguration.update({
          where: { id },
          data: {
            name: parsed.data.name ?? existing.name,
            notes: parsed.data.notes !== undefined ? parsed.data.notes : existing.notes,
            isActive: parsed.data.isActive ?? existing.isActive,
            ...(parsed.data.config !== undefined
              ? { config: config as Prisma.InputJsonValue }
              : {}),
          },
        });
        let versionNumber =
          (
            await tx.configurationVersion.findFirst({
              where: { configurationId: id },
              orderBy: { versionNumber: "desc" },
              select: { versionNumber: true },
            })
          )?.versionNumber ?? 0;
        if (parsed.data.config !== undefined) {
          versionNumber = await this.writeVersion(
            tx,
            id,
            config,
            row.schemaVersion,
            parsed.data.changeNote ?? "updated",
            "panel",
            actorId
          );
        }
        return { row, versionNumber };
      });
      return { ok: true, issues: [], value: this.toDTO(result.row, result.versionNumber) };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return {
          ok: false,
          issues: [{ path: "name", message: "configuration name already exists" }],
        };
      }
      throw err;
    }
  }

  /** Rollback re-validates historical data and records a new version. */
  async rollbackToVersion(
    id: string,
    versionNumber: number,
    actorId: string
  ): Promise<{ ok: boolean; value?: ConfigurationDTOFull; issues?: ZodValidationIssue[] }> {
    const existing = await this.db.protocolConfiguration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing)
      return { ok: false, issues: [{ path: "id", message: "configuration not found" }] };
    const version = await this.db.configurationVersion.findUnique({
      where: { configurationId_versionNumber: { configurationId: id, versionNumber } },
    });
    if (!version) {
      return { ok: false, issues: [{ path: "versionNumber", message: "version not found" }] };
    }
    const adapter = this.registry.require(existing.protocolId);
    const validation = await adapter.validateConfig(version.config);
    if (!validation.valid || !validation.normalized) {
      return { ok: false, issues: validation.issues };
    }
    const result = await this.db.$transaction(async (tx) => {
      const config = await this.prepareConfig(tx, existing.protocolId, id, validation.normalized!);
      const updated = await tx.protocolConfiguration.update({
        where: { id },
        data: { config: config as Prisma.InputJsonValue },
      });
      const n = await this.writeVersion(
        tx,
        id,
        config,
        updated.schemaVersion,
        `rollback to v${versionNumber}`,
        "rollback",
        actorId
      );
      return { updated, version: n };
    });
    return { ok: true, value: this.toDTO(result.updated, result.version) };
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.db.protocolConfiguration.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
    if (result.count === 0) throw Object.assign(new Error("not found"), { statusCode: 404 });
  }

  /**
   * Untrusted external imports. Parse strictly, map only documented fields,
   * drop embedded credentials (never import secrets), validate, then store.
   */
  async importExternal(
    protocolId: string,
    text: unknown,
    source: "import-xray" | "import-singbox",
    actorId: string,
    publicHost?: string
  ): Promise<{ ok: boolean; issues: ZodValidationIssue[]; value?: ConfigurationDTOFull }> {
    const parsedText = parseSafeJson(text);
    if (!parsedText.ok) return { ok: false, issues: [{ path: "text", message: parsedText.error }] };

    let candidate: Record<string, unknown> | null = null;
    if (source === "import-xray") {
      const result = importXrayConfig(text);
      if (result.inbounds.length === 0) {
        return { ok: false, issues: result.issues.map((message) => ({ path: "text", message })) };
      }
      const inbound = result.inbounds.find((i) => i.protocol === protocolId) ?? result.inbounds[0];
      if (!inbound) {
        return { ok: false, issues: [{ path: "inbounds", message: "no supported inbound found" }] };
      }
      if (inbound.protocol !== protocolId) {
        return {
          ok: false,
          issues: [
            {
              path: "protocolId",
              message: `document contains ${inbound.protocol}, not ${protocolId}`,
            },
          ],
        };
      }
      const host =
        publicHost ??
        (inbound.listen && !["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(inbound.listen)
          ? inbound.listen
          : undefined);
      if (!host) {
        return {
          ok: false,
          issues: [
            {
              path: "publicHost",
              message: "a publicHost is required when the inbound listens on a wildcard address",
            },
          ],
        };
      }
      const settings = (inbound.raw.settings ?? {}) as Record<string, unknown>;
      const base = { host, port: inbound.port };
      if (protocolId === "vless" || protocolId === "vmess") {
        candidate = { ...base, transport: mapXrayTransport(inbound.transport) };
      } else if (protocolId === "trojan") {
        const tls = inbound.tlsSettings as Record<string, unknown> | null;
        candidate = {
          ...base,
          tlsSni: typeof tls?.serverName === "string" ? tls.serverName : undefined,
        };
      } else if (protocolId === "shadowsocks") {
        candidate = {
          ...base,
          method: typeof settings.method === "string" ? settings.method : undefined,
          network: settings.network === "tcp,udp" || settings.network === "udp" ? "tcp,udp" : "tcp",
        };
      } else if (protocolId === "socks" || protocolId === "http") {
        candidate = { ...base, bindAddress: "0.0.0.0" };
      }
    } else {
      const result = importSingboxConfig(text);
      if (result.outbounds.length === 0) {
        return { ok: false, issues: result.issues.map((message) => ({ path: "text", message })) };
      }
      const outbound = result.outbounds.find((o) => o.type === protocolId) ?? result.outbounds[0];
      if (!outbound) {
        return {
          ok: false,
          issues: [{ path: "outbounds", message: "no supported outbound found" }],
        };
      }
      if (outbound.type !== protocolId) {
        return {
          ok: false,
          issues: [
            {
              path: "protocolId",
              message: `document contains ${outbound.type}, not ${protocolId}`,
            },
          ],
        };
      }
      if (!outbound.server || !outbound.serverPort) {
        return {
          ok: false,
          issues: [{ path: "outbounds", message: "outbound is missing server or server_port" }],
        };
      }
      const raw = outbound.raw;
      const tls = raw.tls as Record<string, unknown> | undefined;
      const transport = raw.transport as Record<string, unknown> | undefined;
      const base = { host: outbound.server, port: outbound.serverPort };
      if (protocolId === "vless" || protocolId === "vmess") {
        candidate = {
          ...base,
          transport: {
            network: typeof transport?.type === "string" ? transport.type : "tcp",
            path: typeof transport?.path === "string" ? transport.path : undefined,
            serviceName:
              typeof transport?.service_name === "string" ? transport.service_name : undefined,
            security: tls?.enabled === true ? "tls" : "none",
            tlsSni: typeof tls?.server_name === "string" ? tls.server_name : undefined,
          },
        };
      } else if (protocolId === "trojan") {
        candidate = {
          ...base,
          tlsSni: typeof tls?.server_name === "string" ? tls.server_name : undefined,
        };
      } else if (protocolId === "shadowsocks") {
        candidate = {
          ...base,
          method: typeof raw.method === "string" ? raw.method : undefined,
          network: "tcp",
        };
      } else if (protocolId === "socks" || protocolId === "http") {
        candidate = { ...base, bindAddress: "0.0.0.0" };
      }
    }

    if (!candidate) {
      return {
        ok: false,
        issues: [{ path: "protocolId", message: `imports are not supported for ${protocolId}` }],
      };
    }
    const adapter = this.registry.get(protocolId);
    if (!adapter) {
      return { ok: false, issues: [{ path: "protocolId", message: "unknown protocol" }] };
    }
    const validation = await adapter.validateConfig(candidate);
    if (!validation.valid || !validation.normalized) {
      return { ok: false, issues: validation.issues };
    }
    const name = `import-${source.replace("import-", "")}-${Date.now().toString(36)}`.slice(0, 120);
    const created = await this.db.$transaction(async (tx) => {
      await this.ensureProtocolRow(tx, protocolId);
      const row = await tx.protocolConfiguration.create({
        data: {
          protocolId,
          name,
          schemaVersion: "1",
          config: validation.normalized as Prisma.InputJsonValue,
          isActive: false, // imported configs require explicit review before activation
        },
      });
      const config = await this.prepareConfig(tx, protocolId, row.id, validation.normalized!);
      if (protocolId === "wireguard") {
        await tx.protocolConfiguration.update({
          where: { id: row.id },
          data: { config: config as Prisma.InputJsonValue },
        });
      }
      const version = await this.writeVersion(
        tx,
        row.id,
        config,
        row.schemaVersion,
        `imported from ${source}`,
        source,
        actorId
      );
      return { row: { ...row, config: config as Prisma.JsonValue }, version };
    });
    return { ok: true, issues: [], value: this.toDTO(created.row, created.version) };
  }

  async list(protocolId?: string): Promise<ConfigurationDTOFull[]> {
    const where: Prisma.ProtocolConfigurationWhereInput = { deletedAt: null };
    if (protocolId) where.protocolId = protocolId;
    const rows = await this.db.protocolConfiguration.findMany({
      where,
      orderBy: [{ protocolId: "asc" }, { name: "asc" }],
    });
    const versionCounts = await this.db.configurationVersion.groupBy({
      by: ["configurationId"],
      _max: { versionNumber: true },
    });
    const vmap = new Map(versionCounts.map((v) => [v.configurationId, v._max.versionNumber ?? 0]));
    return rows.map((r) => this.toDTO(r, vmap.get(r.id) ?? 0));
  }

  toDTO(
    r: {
      id: string;
      protocolId: string;
      name: string;
      schemaVersion: string;
      config: Prisma.JsonValue;
      isActive: boolean;
      notes: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    currentVersion = 0
  ): ConfigurationDTOFull {
    return {
      id: r.id,
      protocolId: r.protocolId,
      protocolName:
        this.registry.get(r.protocolId)?.displayName ??
        catalogEntry(r.protocolId)?.displayName ??
        r.protocolId,
      name: r.name,
      schemaVersion: r.schemaVersion,
      config: r.config as Record<string, unknown>,
      isActive: r.isActive,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      currentVersion,
    };
  }

  async versions(
    id: string,
    page: number,
    pageSize: number
  ): Promise<{
    items: {
      id: string;
      configurationId: string;
      versionNumber: number;
      config: Record<string, unknown>;
      schemaVersion: string;
      changeNote: string | null;
      source: string;
      createdBy: string | null;
      createdAt: string;
    }[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const [rows, total] = await Promise.all([
      this.db.configurationVersion.findMany({
        where: { configurationId: id },
        orderBy: { versionNumber: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { createdBy: true },
      }),
      this.db.configurationVersion.count({ where: { configurationId: id } }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        configurationId: r.configurationId,
        versionNumber: r.versionNumber,
        config: r.config as Record<string, unknown>,
        schemaVersion: r.schemaVersion,
        changeNote: r.changeNote,
        source: r.source,
        createdBy: r.createdBy?.username ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    };
  }

  private async exportCredentialsForConfiguration(
    configurationId: string
  ): Promise<ExportCredential[]> {
    const rows = await this.db.credentialReference.findMany({
      where: {
        configurationId,
        revokedAt: null,
        client: {
          deletedAt: null,
          isDisabled: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      include: { client: true },
    });
    const out: ExportCredential[] = [];
    for (const row of rows) {
      try {
        const raw = open(row.sealedSecret, this.cfg.encryptionKey);
        const secret = JSON.parse(raw) as Record<string, string>;
        if (!secret || typeof secret !== "object") continue;
        out.push({
          id: row.id,
          clientId: row.clientId,
          clientLabel: row.client.label,
          publicData: row.displayData as Record<string, unknown>,
          secret,
        });
      } catch {
        // A corrupted sealed envelope is skipped, never replaced with fake data.
      }
    }
    return out;
  }

  /** Full server-side Xray configuration generated from active panel configs. */
  async exportXraySkeleton(): Promise<string> {
    const actives = await this.db.protocolConfiguration.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const inbounds: Record<string, unknown>[] = [];
    for (const configRow of actives) {
      if (
        !["vless", "vmess", "trojan", "shadowsocks", "socks", "http"].includes(configRow.protocolId)
      ) {
        continue;
      }
      const adapter = this.registry.require(configRow.protocolId);
      const credentials = await this.exportCredentialsForConfiguration(configRow.id);
      const exported = adapter.exportConfig(
        configRow.config as Record<string, unknown>,
        configRow.schemaVersion,
        credentials
      );
      try {
        const inbound = JSON.parse(exported.content) as Record<string, unknown>;
        inbound.tag = `${configRow.protocolId}-${configRow.name}`
          .replace(/[^A-Za-z0-9_.-]/g, "-")
          .slice(0, 64);
        inbounds.push(inbound);
      } catch {
        // Unexpected adapter output is skipped rather than injected.
      }
    }
    return JSON.stringify(newXraySkeleton({ inbounds }), null, 2);
  }

  /** Complete server-side artifact for one configuration (admin download). */
  async exportServerArtifact(
    id: string
  ): Promise<{ ok: boolean; error?: string; result?: ExportResult }> {
    const configRow = await this.db.protocolConfiguration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!configRow) return { ok: false, error: "configuration not found" };
    const adapter = this.registry.require(configRow.protocolId);
    const credentials = await this.exportCredentialsForConfiguration(configRow.id);
    let result = adapter.exportConfig(
      configRow.config as Record<string, unknown>,
      configRow.schemaVersion,
      credentials
    );

    if (configRow.protocolId === "wireguard") {
      const key = await readWireGuardServerKey(this.db, this.cfg, configRow.id);
      if (!key) {
        return {
          ok: false,
          error:
            "WireGuard server private key is not provisioned. Assign at least one client to provision it.",
        };
      }
      result = {
        ...result,
        content: result.content.replace("<PROVISIONED_SERVER_PRIVATE_KEY>", key.privateKey),
      };
    }

    if (contentLooksLikeXrayInbound(result.content)) {
      try {
        const inbound = JSON.parse(result.content) as Record<string, unknown>;
        inbound.tag = `${configRow.protocolId}-${configRow.name}`
          .replace(/[^A-Za-z0-9_.-]/g, "-")
          .slice(0, 64);
        result = {
          filename: `${configRow.protocolId}-server-xray.json`,
          contentType: "application/json",
          content: JSON.stringify(newXraySkeleton({ inbounds: [inbound] }), null, 2),
        };
      } catch {
        // keep adapter output
      }
    }
    return { ok: true, result };
  }

  /** Export a client-facing artifact for one (client, configuration). */
  async exportClientArtifact(
    clientId: string,
    configurationId: string
  ): Promise<{
    ok: boolean;
    error?: string;
    content?: string;
    contentType?: string;
    filename?: string;
    uri?: string | null;
  }> {
    const [client, configuration] = await Promise.all([
      this.db.client.findFirst({ where: { id: clientId, deletedAt: null } }),
      this.db.protocolConfiguration.findFirst({ where: { id: configurationId, deletedAt: null } }),
    ]);
    if (!client || !configuration) return { ok: false, error: "client or configuration not found" };
    if (configuration.isActive === false) return { ok: false, error: "configuration is inactive" };
    if (client.isDisabled) return { ok: false, error: "client is disabled" };
    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
      return {
        ok: false,
        error:
          "client is expired; panel-side delivery is blocked (network enforcement depends on the external runtime)",
      };
    }
    const credential = await this.db.credentialReference.findFirst({
      where: { clientId, configurationId, revokedAt: null },
    });
    if (!credential) return { ok: false, error: "no credential assigned" };

    let secretObj: Record<string, string>;
    try {
      secretObj = JSON.parse(open(credential.sealedSecret, this.cfg.encryptionKey)) as Record<
        string,
        string
      >;
    } catch {
      return { ok: false, error: "failed to open sealed credential" };
    }

    const adapter = this.registry.require(configuration.protocolId);
    const config = configuration.config as Record<string, unknown>;
    const serverHost =
      (configuration.protocolId === "wireguard"
        ? (config.serverEndpointHost as string | undefined)
        : (config.host as string | undefined)) ??
      (config.host as string | undefined) ??
      "";
    const serverPort =
      (configuration.protocolId === "wireguard"
        ? (config.serverEndpointPort as number | undefined)
        : (config.port as number | undefined)) ??
      (config.port as number | undefined) ??
      0;
    if (!serverHost || !serverPort) {
      return { ok: false, error: "configuration has no public endpoint for clients" };
    }

    try {
      const generated = await adapter.generateClientConfig({
        serverHost,
        serverPort,
        credential: secretObj,
        settings: config,
        remark: client.label,
      });
      const isJson = generated.content.trimStart().startsWith("{");
      const contentType = isJson
        ? "application/json"
        : configuration.protocolId === "openvpn"
          ? "application/x-openvpn-profile"
          : "text/plain; charset=utf-8";
      const extension =
        configuration.protocolId === "openvpn"
          ? ".ovpn"
          : configuration.protocolId === "wireguard"
            ? ".conf"
            : isJson
              ? ".json"
              : ".txt";
      const safeLabel = client.label.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40) || "client";
      return {
        ok: true,
        content: generated.content,
        contentType,
        filename: `${adapter.id}-${safeLabel}${extension}`,
        uri: generated.uri ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "could not generate client configuration",
      };
    }
  }
}
