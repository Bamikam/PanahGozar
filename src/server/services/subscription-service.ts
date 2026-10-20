import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../env-types.js";
import type { ProtocolRegistry } from "../protocols/registry.js";
import type { ClientConfigInput } from "../protocols/types.js";
import { generateSubscriptionToken, sha256, tokenHint } from "../security/tokens.js";
import { open } from "../security/sealed-store.js";
import type { SubscriptionFormat } from "../../shared/types.js";

/**
 * Subscription system.
 *
 * - Tokens are 160-bit CSPRNG values, hashed (SHA-256) at rest; raw tokens
 *   exist only in the HTTP response at creation/rotation time.
 * - Tokens are never logged; request logging redacts /api/sub/<token>.
 * - Revocation, subscription expiry, client disable/expiry and configuration
 *   deactivation are enforced at fetch time.
 * - Only artifacts explicitly advertised by the adapter for the requested
 *   format are included. Nothing here implies a live remote listener.
 */
export type SubFormat = "xray_uri" | "raw_uri" | "singbox_json";

export interface CreateSubscriptionInput {
  clientId: string;
  name: string;
  format?: SubFormat;
  expiresAt?: string | null;
}

export interface SubscriptionCreateResult {
  id: string;
  url: string;
  tokenHint: string;
  format: SubFormat;
  expiresAt: string | null;
}

export class SubscriptionService {
  constructor(
    private db: PrismaClient,
    private cfg: AppConfig,
    private registry: ProtocolRegistry
  ) {}

  async create(
    input: CreateSubscriptionInput,
    _actorId: string
  ): Promise<{ ok: boolean; error?: string; value?: SubscriptionCreateResult }> {
    if (!input.name || input.name.length > 80)
      return { ok: false, error: "name must be 1-80 chars" };
    const client = await this.db.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) return { ok: false, error: "client not found" };
    if (client.isDisabled) return { ok: false, error: "client is disabled" };
    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: "client is expired" };
    }

    const format: SubFormat = input.format ?? "xray_uri";
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) return { ok: false, error: "invalid expiresAt" };
      if (expiresAt.getTime() <= Date.now()) {
        return { ok: false, error: "expiresAt must be in the future" };
      }
    }

    const maxSetting = await this.db.applicationSetting.findUnique({
      where: { key: "subscription.maxPerClient" },
    });
    const parsedMax = typeof maxSetting?.value === "number" ? maxSetting.value : 10;
    const maxPerClient = Math.max(1, Math.min(50, parsedMax));
    const existingCount = await this.db.subscription.count({
      where: { clientId: client.id, revokedAt: null },
    });
    if (existingCount >= maxPerClient) {
      return { ok: false, error: `active subscription limit reached (${maxPerClient})` };
    }

    const token = generateSubscriptionToken();
    const row = await this.db.subscription.create({
      data: {
        clientId: client.id,
        name: input.name,
        format,
        tokenHash: sha256(token),
        tokenHint: tokenHint(token),
        expiresAt,
      },
    });

    return {
      ok: true,
      value: {
        id: row.id,
        url: `${this.cfg.publicUrl}/api/sub/${token}`,
        tokenHint: row.tokenHint,
        format,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    };
  }

  async rotate(id: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const row = await this.db.subscription.findUnique({ where: { id } });
    if (!row || row.revokedAt) return { ok: false, error: "subscription not found or revoked" };
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: "subscription itself has expired; create a new one" };
    }
    const token = generateSubscriptionToken();
    await this.db.subscription.update({
      where: { id },
      data: {
        tokenHash: sha256(token),
        tokenHint: tokenHint(token),
        tokenRotatedAt: new Date(),
      },
    });
    return { ok: true, url: `${this.cfg.publicUrl}/api/sub/${token}` };
  }

  async revoke(id: string, reason: string): Promise<{ ok: boolean }> {
    const result = await this.db.subscription.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 300) },
    });
    return { ok: result.count > 0 };
  }

  async listByClient(clientId: string) {
    return this.db.subscription.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      include: { client: true },
    });
  }

  async listAll(page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      this.db.subscription.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { client: true },
      }),
      this.db.subscription.count(),
    ]);
    return { rows, total };
  }

  private toClientInput(
    protocolId: string,
    config: Record<string, unknown>,
    credential: Record<string, string>,
    remark: string
  ): ClientConfigInput | null {
    if (protocolId === "wireguard") return null;
    const serverHost = config.host;
    const serverPort = config.port;
    if (typeof serverHost !== "string" || typeof serverPort !== "number") return null;
    return { serverHost, serverPort, credential, settings: config, remark };
  }

  /**
   * Resolves a token to the subscription payload. Returns null for invalid,
   * revoked, expired, disabled or deleted subscriptions. The URL is never logged.
   */
  async resolveByToken(rawToken: string): Promise<null | {
    format: SubFormat;
    payload: string;
    contentType: string;
  }> {
    const tokenHash = sha256(rawToken);
    const row = await this.db.subscription.findUnique({
      where: { tokenHash },
      include: { client: true },
    });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    if (row.client.isDisabled || row.client.deletedAt) return null;
    if (row.client.expiresAt && row.client.expiresAt.getTime() <= Date.now()) return null;

    const payload = await this.buildPayload(row.clientId, row.format);
    await this.db.subscription.update({
      where: { id: row.id },
      data: { lastAccessAt: new Date(), accessCount: { increment: 1 } },
    });
    return { format: row.format, ...payload };
  }

  private async buildPayload(
    clientId: string,
    format: SubFormat
  ): Promise<{ payload: string; contentType: string }> {
    const credentials = await this.db.credentialReference.findMany({
      where: {
        clientId,
        revokedAt: null,
        configuration: { deletedAt: null, isActive: true },
      },
      include: { configuration: true, client: true },
    });

    const lines: string[] = [];
    const singboxOutbounds: Record<string, unknown>[] = [];
    let index = 0;

    for (const cred of credentials) {
      if (!cred.configuration) continue;
      const adapter = this.registry.get(cred.protocolId);
      if (!adapter) continue;
      const formats = adapter.supportedSubscriptionFormats();
      if (!formats.includes(format)) continue;
      const config = cred.configuration.config as Record<string, unknown>;

      let secret: Record<string, string>;
      try {
        secret = JSON.parse(open(cred.sealedSecret, this.cfg.encryptionKey)) as Record<
          string,
          string
        >;
      } catch {
        continue;
      }
      const input = this.toClientInput(cred.protocolId, config, secret, cred.configuration.name);
      if (!input) continue;

      try {
        index += 1;
        if (format === "singbox_json") {
          if (!adapter.generateSingboxOutbound) continue;
          const outbound = await adapter.generateSingboxOutbound(input);
          outbound.tag = `${cred.protocolId}-${index}`.replace(/[^A-Za-z0-9_.-]/g, "-");
          singboxOutbounds.push(outbound);
          continue;
        }
        const generated = await adapter.generateClientConfig(input);
        if (format === "xray_uri") {
          if (generated.uri) lines.push(generated.uri);
        } else {
          if (generated.uri) lines.push(generated.uri);
          else if (generated.content.trim().startsWith("{")) {
            lines.push(JSON.stringify(JSON.parse(generated.content)));
          }
        }
      } catch {
        // Misconfigured assignments are skipped, never fabricated.
      }
    }

    if (format === "singbox_json") {
      const outbounds = [
        ...singboxOutbounds,
        { type: "direct", tag: "direct" },
        { type: "block", tag: "block" },
      ];
      const finalTag = (singboxOutbounds[0]?.tag as string | undefined) ?? "direct";
      return {
        payload: JSON.stringify(
          {
            log: { level: "warn", timestamp: true },
            inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
            outbounds,
            route: {
              rules: [],
              final: finalTag,
              auto_detect_interface: true,
            },
          },
          null,
          2
        ),
        contentType: "application/json; charset=utf-8",
      };
    }

    if (lines.length === 0) {
      return {
        payload: "# No compatible configurations are assigned to this subscription yet.\n",
        contentType: "text/plain; charset=utf-8",
      };
    }
    if (format === "xray_uri") {
      return {
        payload: Buffer.from(lines.join("\n"), "utf8").toString("base64"),
        contentType: "text/plain; charset=utf-8",
      };
    }
    return {
      payload: lines.join("\n") + "\n",
      contentType: "text/plain; charset=utf-8",
    };
  }

  async buildItemsForClient(clientId: string, format: SubFormat): Promise<string[]> {
    const payload = await this.buildPayload(clientId, format);
    if (format === "singbox_json") {
      try {
        const parsed = JSON.parse(payload.payload) as { outbounds?: unknown[] };
        return (parsed.outbounds ?? [])
          .filter((o) => {
            const type = (o as { type?: string }).type;
            return type && type !== "direct" && type !== "block";
          })
          .map((o) => JSON.stringify(o));
      } catch {
        return [];
      }
    }
    if (format === "xray_uri") {
      const decoded = Buffer.from(payload.payload, "base64").toString("utf8");
      return decoded.startsWith("#") ? [] : decoded.split("\n").filter(Boolean);
    }
    return payload.payload
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }
}
