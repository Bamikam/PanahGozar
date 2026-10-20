import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { seal, open } from "../security/sealed-store.js";
import type { AppConfig } from "../env-types.js";
import type { ProtocolRegistry } from "../protocols/registry.js";
import {
  generateUuid,
  generateRandomSecret,
  generateMtprotoSecret,
  generateProxyUsername,
} from "../security/tokens.js";
import type { ClientAssignmentDTO, ClientDTO, ClientDetailDTO } from "../../shared/types.js";
import { generateWireGuardKeypair, isValidWireGuardKey } from "../protocols/adapters/wireguard.js";

/**
 * Client management service. Multi-table writes are transactional.
 * Credential material is AES-256-GCM sealed before it touches PostgreSQL;
 * display data never contains secret values.
 */
const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !/[<>{}]/.test(v), "label may not contain <, >, {, or }");

const dateSchema = z
  .string()
  .max(50)
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a valid date/time")
  .transform((v) => new Date(v).toISOString());

const quotaSchema = z
  .union([
    z.string().regex(/^\d+$/, "must be a non-negative integer string"),
    z.number().int().nonnegative(),
  ])
  .nullable();

export const ClientCreateSchema = z.object({
  label: labelSchema,
  email: z.union([z.string().trim().email().max(160), z.literal(""), z.null()]).optional(),
  notes: z.union([z.string().max(4000), z.null()]).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  isDisabled: z.boolean().optional(),
  expiresAt: z.union([dateSchema, z.literal(""), z.null()]).optional(),
  trafficQuotaBytes: quotaSchema.optional(),
  maxConnections: z.union([z.number().int().min(0).max(100000), z.null()]).optional(),
});

export const ClientUpdateSchema = ClientCreateSchema.partial();

export type CreateClientInput = z.input<typeof ClientCreateSchema>;
export type UpdateClientInput = z.input<typeof ClientUpdateSchema>;

export interface AssignProtocolInput {
  clientId: string;
  configurationId: string;
}

export type CredentialKindValue =
  | "vless_uuid"
  | "vmess_uuid"
  | "trojan_password"
  | "shadowsocks_password"
  | "socks_username"
  | "http_username"
  | "mtproto_secret"
  | "wireguard_keypair"
  | "openvpn_credentials";

export function buildCredentialForProtocol(
  protocolId: string,
  key: Buffer,
  options?: { wireguardAddressCidr?: string }
): { kind: CredentialKindValue; sealed: string; displayData: Record<string, unknown> } {
  const sealObject = (obj: Record<string, unknown>) => seal(JSON.stringify(obj), key);
  switch (protocolId) {
    case "vless":
    case "vmess": {
      const uuid = generateUuid();
      return {
        kind: protocolId === "vless" ? "vless_uuid" : "vmess_uuid",
        sealed: sealObject({ uuid }),
        displayData: { uuidHint: `${uuid.slice(0, 8)}...` },
      };
    }
    case "trojan":
      return {
        kind: "trojan_password",
        sealed: sealObject({ password: generateRandomSecret() }),
        displayData: {},
      };
    case "shadowsocks":
      return {
        kind: "shadowsocks_password",
        sealed: sealObject({ password: generateRandomSecret() }),
        displayData: {},
      };
    case "socks":
    case "http": {
      const username = generateProxyUsername();
      const password = generateRandomSecret();
      return {
        kind: protocolId === "socks" ? "socks_username" : "http_username",
        sealed: sealObject({ username, password }),
        displayData: { username },
      };
    }
    case "mtproto": {
      const secret = generateMtprotoSecret(true);
      return {
        kind: "mtproto_secret",
        sealed: sealObject({ secret }),
        displayData: { secretHint: `${secret.slice(0, 6)}...` },
      };
    }
    case "wireguard": {
      if (!options?.wireguardAddressCidr) {
        throw new Error("WireGuard credentials require an allocated client address");
      }
      const pair = generateWireGuardKeypair();
      const presharedKey = generateWireGuardKeypair().privateKey;
      return {
        kind: "wireguard_keypair",
        sealed: sealObject({
          privateKey: pair.privateKey,
          publicKey: pair.publicKey,
          presharedKey,
          addressCidr: options.wireguardAddressCidr,
        }),
        displayData: {
          publicKey: pair.publicKey,
          addressCidr: options.wireguardAddressCidr,
        },
      };
    }
    case "openvpn": {
      const username = `ovpn_${generateProxyUsername()}`;
      const password = generateRandomSecret();
      return {
        kind: "openvpn_credentials",
        sealed: sealObject({ username, password }),
        displayData: { username },
      };
    }
    default:
      throw new Error(`protocol ${protocolId} has no credential builder`);
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const err = Object.assign(new Error("validation failed"), {
      statusCode: 400,
      details: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    });
    throw err;
  }
  return parsed.data;
}

function nullableEmail(value: string | null | undefined): string | null {
  if (value === undefined) return null;
  if (value === null || value === "") return null;
  return value;
}

function toBigInt(value: string | number | null | undefined): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  return BigInt(String(value));
}

export class ClientService {
  constructor(
    private db: PrismaClient,
    private cfg: AppConfig,
    private registry: ProtocolRegistry
  ) {}

  toDTO(
    c: {
      id: string;
      label: string;
      email: string | null;
      notes: string | null;
      tags: string[];
      isDisabled: boolean;
      expiresAt: Date | null;
      trafficQuotaBytes: bigint | null;
      trafficEnforcement: string;
      maxConnections: number | null;
      createdAt: Date;
      updatedAt: Date;
    },
    extras?: { protocolIds?: string[]; subscriptionCount?: number }
  ): ClientDTO {
    const isExpired = Boolean(c.expiresAt && c.expiresAt.getTime() <= Date.now());
    return {
      id: c.id,
      label: c.label,
      email: c.email,
      notes: c.notes,
      tags: c.tags,
      isDisabled: c.isDisabled,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      isExpired,
      trafficQuotaBytes: c.trafficQuotaBytes !== null ? String(c.trafficQuotaBytes) : null,
      trafficEnforcement: c.trafficEnforcement as ClientDTO["trafficEnforcement"],
      maxConnections: c.maxConnections,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      limitEnforcement: {
        expiry: "panel",
        trafficQuota: c.trafficEnforcement as ClientDTO["trafficEnforcement"],
        maxConnections: "unavailable",
      },
      ...extras,
    };
  }

  async create(input: unknown): Promise<ClientDTO> {
    const data = parseInput(ClientCreateSchema, input);
    const c = await this.db.client.create({
      data: {
        label: data.label,
        email: nullableEmail(data.email),
        notes: data.notes ?? null,
        tags: data.tags ?? [],
        isDisabled: data.isDisabled ?? false,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        trafficQuotaBytes: toBigInt(data.trafficQuotaBytes),
        // The panel never claims runtime enforcement. The external server must
        // consume and enforce these values; until then they are recorded limits.
        trafficEnforcement: "unavailable",
        maxConnections: data.maxConnections ?? null,
      },
    });
    return this.toDTO(c);
  }

  async update(id: string, input: unknown): Promise<ClientDTO> {
    const data = parseInput(ClientUpdateSchema, input);
    const existing = await this.db.client.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    const patch: Prisma.ClientUpdateInput = {};
    if (data.label !== undefined) patch.label = data.label;
    if (data.email !== undefined) patch.email = nullableEmail(data.email);
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.tags !== undefined) patch.tags = data.tags;
    if (data.isDisabled !== undefined) patch.isDisabled = data.isDisabled;
    if (data.expiresAt !== undefined) {
      patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    }
    if (data.trafficQuotaBytes !== undefined) {
      patch.trafficQuotaBytes = toBigInt(data.trafficQuotaBytes);
      patch.trafficEnforcement = "unavailable";
    }
    if (data.maxConnections !== undefined) patch.maxConnections = data.maxConnections;
    const c = await this.db.client.update({ where: { id }, data: patch });
    return this.toDTO(c);
  }

  async softDelete(id: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const existing = await tx.client.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw Object.assign(new Error("not found"), { statusCode: 404 });
      await tx.client.update({ where: { id }, data: { deletedAt: new Date(), isDisabled: true } });
      await tx.subscription.updateMany({
        where: { clientId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "client deleted" },
      });
    });
  }

  async revoke(id: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const existing = await tx.client.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw Object.assign(new Error("not found"), { statusCode: 404 });
      await tx.client.update({ where: { id }, data: { isDisabled: true } });
      await tx.subscription.updateMany({
        where: { clientId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "client revoked" },
      });
    });
  }

  /** Race-safe-ish provisioning inside the caller's transaction. */
  private async ensureWireGuardServerKey(
    tx: Prisma.TransactionClient,
    configurationId: string,
    config: Record<string, unknown>
  ): Promise<{ serverPublicKey: string; config: Record<string, unknown> }> {
    const settingKey = `wireguard.serverKey.${configurationId}`;
    const existing = await tx.applicationSetting.findUnique({ where: { key: settingKey } });
    if (existing) {
      const raw = (existing.value as { sealed?: string } | null)?.sealed;
      if (typeof raw === "string") {
        try {
          const pair = JSON.parse(open(raw, this.cfg.encryptionKey)) as {
            privateKey?: string;
            publicKey?: string;
          };
          if (pair.publicKey && isValidWireGuardKey(pair.publicKey)) {
            return {
              serverPublicKey: pair.publicKey,
              config: { ...config, serverPublicKey: pair.publicKey },
            };
          }
        } catch {
          // fall through and reprovision
        }
      }
    }
    const pair = generateWireGuardKeypair();
    const sealed = seal(JSON.stringify(pair), this.cfg.encryptionKey);
    await tx.applicationSetting.upsert({
      where: { key: settingKey },
      update: { value: { sealed } },
      create: { key: settingKey, value: { sealed } },
    });
    const nextConfig = { ...config, serverPublicKey: pair.publicKey };
    return { serverPublicKey: pair.publicKey, config: nextConfig };
  }

  private async allocateWireGuardAddress(
    tx: Prisma.TransactionClient,
    configurationId: string,
    listenAddressCidr: string
  ): Promise<string> {
    const active = await tx.credentialReference.findMany({
      where: { configurationId, protocolId: "wireguard", revokedAt: null },
      select: { displayData: true },
    });
    const used = new Set(
      active
        .map((c) => (c.displayData as { addressCidr?: unknown } | null)?.addressCidr)
        .filter((v): v is string => typeof v === "string")
    );
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(listenAddressCidr);
    if (!match) throw new Error("invalid WireGuard listenAddressCidr");
    const octets = match.slice(1, 5).map(Number);
    const prefix = Number(match[5]);
    if (octets.some((octet) => octet < 0 || octet > 255) || prefix < 8 || prefix > 30) {
      throw new Error("invalid WireGuard listenAddressCidr");
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const size = 2 ** (32 - prefix);
    const network = (base & (~(size - 1) >>> 0)) >>> 0;
    const lastUsable = network + size - 2;
    for (let candidate = Math.max(base + 1, network + 1); candidate <= lastUsable; candidate++) {
      if (used.size >= Math.max(1, size - 3)) break;
      const ip = [
        candidate >>> 24,
        (candidate >>> 16) & 255,
        (candidate >>> 8) & 255,
        candidate & 255,
      ].join(".");
      const addressCidr = `${ip}/32`;
      if (!used.has(addressCidr)) return addressCidr;
    }
    throw new Error("WireGuard address pool exhausted");
  }

  /**
   * Assigns a client to a configuration and creates a matching sealed
   * credential atomically. If an active credential already exists, its id is
   * returned without rotating secrets.
   */
  async assignToConfiguration(input: AssignProtocolInput): Promise<{ credentialId: string }> {
    return this.db.$transaction(async (tx) => {
      const configuration = await tx.protocolConfiguration.findFirst({
        where: { id: input.configurationId, deletedAt: null, isActive: true },
      });
      if (!configuration) {
        throw Object.assign(new Error("configuration not found or inactive"), { statusCode: 404 });
      }
      const client = await tx.client.findFirst({ where: { id: input.clientId, deletedAt: null } });
      if (!client) throw Object.assign(new Error("client not found"), { statusCode: 404 });
      if (client.isDisabled) {
        throw Object.assign(new Error("client is disabled"), { statusCode: 409 });
      }
      if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
        throw Object.assign(new Error("client is expired"), { statusCode: 409 });
      }
      const adapter = this.registry.get(configuration.protocolId);
      if (!adapter) {
        throw Object.assign(new Error("unknown protocol"), { statusCode: 400 });
      }
      const existing = await tx.credentialReference.findFirst({
        where: { clientId: client.id, configurationId: configuration.id, revokedAt: null },
      });
      if (existing) return { credentialId: existing.id };

      let config = configuration.config as Record<string, unknown>;
      let wireguardAddressCidr: string | undefined;
      if (configuration.protocolId === "wireguard") {
        const provisioned = await this.ensureWireGuardServerKey(tx, configuration.id, config);
        config = provisioned.config;
        const listenAddressCidr =
          typeof config.listenAddressCidr === "string" ? config.listenAddressCidr : "";
        wireguardAddressCidr = await this.allocateWireGuardAddress(
          tx,
          configuration.id,
          listenAddressCidr
        );
        await tx.protocolConfiguration.update({
          where: { id: configuration.id },
          data: { config: config as Prisma.InputJsonValue },
        });
      }

      const cred = buildCredentialForProtocol(configuration.protocolId, this.cfg.encryptionKey, {
        wireguardAddressCidr,
      });
      const row = await tx.credentialReference.create({
        data: {
          clientId: client.id,
          configurationId: configuration.id,
          protocolId: configuration.protocolId,
          kind: cred.kind,
          displayData: cred.displayData as Prisma.InputJsonValue,
          sealedSecret: cred.sealed,
        },
      });
      return { credentialId: row.id };
    });
  }

  async unassignFromConfiguration(clientId: string, configurationId: string): Promise<number> {
    const result = await this.db.credentialReference.updateMany({
      where: { clientId, configurationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Rotate the credential of an active (client, configuration) assignment. */
  async rotateCredential(clientId: string, configurationId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const cred = await tx.credentialReference.findFirst({
        where: { clientId, configurationId, revokedAt: null },
      });
      if (!cred)
        throw Object.assign(new Error("no active credential for assignment"), { statusCode: 404 });
      const configuration = await tx.protocolConfiguration.findFirst({
        where: { id: configurationId, deletedAt: null },
      });
      if (!configuration)
        throw Object.assign(new Error("configuration not found"), { statusCode: 404 });
      let addressCidr: string | undefined;
      if (cred.protocolId === "wireguard") {
        const display = cred.displayData as { addressCidr?: unknown } | null;
        addressCidr = typeof display?.addressCidr === "string" ? display.addressCidr : undefined;
        if (!addressCidr) {
          const config = configuration.config as Record<string, unknown>;
          const listen =
            typeof config.listenAddressCidr === "string" ? config.listenAddressCidr : "";
          addressCidr = await this.allocateWireGuardAddress(tx, configuration.id, listen);
        }
      }
      const fresh = buildCredentialForProtocol(cred.protocolId, this.cfg.encryptionKey, {
        wireguardAddressCidr: addressCidr,
      });
      await tx.credentialReference.update({
        where: { id: cred.id },
        data: {
          sealedSecret: fresh.sealed,
          displayData: fresh.displayData as Prisma.InputJsonValue,
        },
      });
      if (cred.protocolId === "wireguard") {
        const config = configuration.config as Record<string, unknown>;
        await this.ensureWireGuardServerKey(tx, configuration.id, config);
      }
    });
  }

  async revokeCredential(clientId: string, configurationId: string): Promise<number> {
    const result = await this.db.credentialReference.updateMany({
      where: { clientId, configurationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async list(opts: {
    page: number;
    pageSize: number;
    search?: string;
    disabled?: boolean;
    tag?: string;
    orderBy?: "createdAt" | "label" | "expiresAt";
  }): Promise<{ items: ClientDTO[]; page: number; pageSize: number; total: number }> {
    const where: Prisma.ClientWhereInput = { deletedAt: null };
    if (opts.disabled !== undefined) where.isDisabled = opts.disabled;
    if (opts.tag) where.tags = { has: opts.tag };
    if (opts.search) {
      where.OR = [
        { label: { contains: opts.search, mode: "insensitive" } },
        { email: { contains: opts.search, mode: "insensitive" } },
      ];
    }
    const orderByField = opts.orderBy ?? "createdAt";
    const [rows, total] = await Promise.all([
      this.db.client.findMany({
        where,
        orderBy: { [orderByField]: "desc" },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        include: { _count: { select: { subscriptions: true } } },
      }),
      this.db.client.count({ where }),
    ]);
    return {
      items: rows.map((c) => this.toDTO(c, { subscriptionCount: c._count.subscriptions })),
      page: opts.page,
      pageSize: opts.pageSize,
      total,
    };
  }

  async get(id: string): Promise<ClientDetailDTO | null> {
    const c = await this.db.client.findFirst({
      where: { id, deletedAt: null },
      include: {
        credentials: {
          include: { configuration: true },
          orderBy: { createdAt: "desc" },
        },
        _count: { select: { subscriptions: true } },
      },
    });
    if (!c) return null;
    const assignments: ClientAssignmentDTO[] = c.credentials.map((cred) => ({
      credentialId: cred.id,
      configurationId: cred.configurationId ?? "",
      configurationName: cred.configuration?.name ?? "(deleted configuration)",
      protocolId: cred.protocolId,
      protocolName: this.registry.get(cred.protocolId)?.displayName ?? cred.protocolId,
      kind: cred.kind,
      displayData: cred.displayData as Record<string, unknown>,
      revokedAt: cred.revokedAt?.toISOString() ?? null,
      createdAt: cred.createdAt.toISOString(),
    }));
    const activeProtocols = [
      ...new Set(c.credentials.filter((cred) => !cred.revokedAt).map((cred) => cred.protocolId)),
    ];
    return {
      ...this.toDTO(c, {
        protocolIds: activeProtocols,
        subscriptionCount: c._count.subscriptions,
      }),
      assignments,
    };
  }

  async assertExportable(clientId: string): Promise<{
    id: string;
    label: string;
    isDisabled: boolean;
    expiresAt: Date | null;
  }> {
    const client = await this.db.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true, label: true, isDisabled: true, expiresAt: true },
    });
    if (!client) throw Object.assign(new Error("client not found"), { statusCode: 404 });
    if (client.isDisabled)
      throw Object.assign(new Error("client is disabled"), { statusCode: 409 });
    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
      throw Object.assign(
        new Error(
          "client expired: panel-side export is blocked (runtime enforcement depends on the external server)"
        ),
        { statusCode: 409 }
      );
    }
    return client;
  }
}
