import type { PrismaClient } from "@prisma/client";
import { redactMeta } from "../logger.js";

/**
 * Audit trail for administrative changes. Metadata is defensively re-redacted
 * here — callers must already pass clean data, but the service refuses to
 * write sensitive-looking keys verbatim, whatever its caller believed.
 */
export interface AuditInput {
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditService {
  constructor(private db: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.db.auditEvent.create({
        data: {
          actorId: input.actorId ?? null,
          actorLabel: input.actorLabel ?? "system",
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          meta: redactMeta(input.meta ?? {}) as object,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 250) ?? null,
        },
      });
    } catch (err) {
      // Audit failures must not break admin operations; they surface in logs.
      console.error("audit write failed", err instanceof Error ? err.message : err);
    }
  }

  async list(opts: {
    page: number;
    pageSize: number;
    action?: string;
    targetType?: string;
  }): Promise<{
    items: {
      id: string;
      actorId: string | null;
      actorLabel: string | null;
      action: string;
      targetType: string;
      targetId: string;
      meta: Record<string, unknown>;
      ip: string | null;
      createdAt: Date;
    }[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const where: { action?: string; targetType?: string } = {};
    if (opts.action) where.action = opts.action;
    if (opts.targetType) where.targetType = opts.targetType;
    const [items, total] = await Promise.all([
      this.db.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.db.auditEvent.count({ where }),
    ]);
    const mapped = items.map((e) => ({
      id: e.id,
      actorId: e.actorId,
      actorLabel: e.actorLabel,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      meta: (e.meta ?? {}) as Record<string, unknown>,
      ip: e.ip,
      createdAt: e.createdAt,
    }));
    return { items: mapped, page: opts.page, pageSize: opts.pageSize, total };
  }

  async recent(limit = 8) {
    return this.db.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
