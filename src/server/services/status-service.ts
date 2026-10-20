import type { PrismaClient } from "@prisma/client";
import type { ProtocolRegistry } from "../protocols/registry.js";
import type { RuntimeState } from "../protocols/types.js";
import type { ProtocolStatusDTO, EnforcementHint } from "../../shared/types.js";

/**
 * Status evaluation (spec section 5).
 *
 * In this deployment status is derived from:
 *   1. presence of active configurations (not_configured vs configured),
 *   2. real adapter capability detection (can this process host it?),
 *   3. recorded, unexpired health-check evidence - the ONLY path to
 *      `running_verified`.
 *
 * No generic "online" flag and no fabricated liveness is ever returned.
 */
const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

export class StatusService {
  constructor(
    private db: PrismaClient,
    private registry: ProtocolRegistry
  ) {}

  async evaluateAll(): Promise<ProtocolStatusDTO[]> {
    const adapters = this.registry.list();
    const configs = await this.db.protocolConfiguration.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, protocolId: true },
    });
    const checks = await this.db.runtimeHealthCheck.findMany({
      orderBy: { recordedAt: "desc" },
      take: 500,
    });
    const byProtocol = new Map<string, number>();
    for (const c of configs) {
      byProtocol.set(c.protocolId, (byProtocol.get(c.protocolId) ?? 0) + 1);
    }

    return Promise.all(
      adapters.map(async (adapter) => {
        const count = byProtocol.get(adapter.id) ?? 0;
        const latest = checks.find((c) => c.protocolId === adapter.id) ?? null;
        const capabilities = await adapter.detectCapabilities();
        const liveCheck =
          latest &&
          latest.expiresAt &&
          latest.expiresAt.getTime() > Date.now() &&
          (latest.outcome === "passed" || latest.outcome === "failed")
            ? latest
            : null;

        const { state, explanation, enforcementNote } = evaluateState(
          count > 0,
          capabilities.canHostInProcess,
          liveCheck?.state ?? null
        );
        return {
          protocolId: adapter.id,
          displayName: adapter.displayName,
          state,
          explanation:
            explanation ??
            (latest && !liveCheck
              ? "A previous health check expired; live verification is required again."
              : "No live health-check evidence has been recorded."),
          lastHealthCheck: latest
            ? {
                state: latest.state,
                outcome: latest.outcome,
                recordedAt: latest.recordedAt.toISOString(),
                latencyMs: latest.latencyMs,
                detail: latest.detail as Record<string, unknown>,
              }
            : null,
          configurationCount: count,
          enforcementNote:
            enforcementNote ??
            "Limits recorded by the panel cannot be enforced without the matching runtime.",
        };
      })
    );
  }

  /** Records a genuine health-check outcome. Only callers with real evidence call this. */
  async recordHealthCheck(
    protocolId: string,
    state: RuntimeState,
    outcome: "failed" | "passed" | "unsupported" | "skipped",
    detail: Record<string, unknown>,
    latencyMs?: number
  ): Promise<void> {
    await this.db.runtimeHealthCheck.create({
      data: {
        protocolId,
        state,
        outcome,
        detail: detail as never,
        latencyMs: latencyMs ?? null,
        expiresAt:
          state === "running_verified" || state === "degraded"
            ? new Date(Date.now() + VERIFICATION_WINDOW_MS)
            : null,
      },
    });
  }

  async overviewStats(): Promise<{
    totalClients: number;
    activeClients: number;
    disabledClients: number;
    expiredClients: number;
    expiringClients7d: number;
    configuredProtocols: number;
    verifiedRunningProtocols: number;
    activeSubscriptions: number;
  }> {
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [
      totalClients,
      activeClients,
      disabledClients,
      expiredClients,
      expiring,
      configGroups,
      activeSubCount,
      verifiedGroups,
    ] = await Promise.all([
      this.db.client.count({ where: { deletedAt: null } }),
      this.db.client.count({ where: { deletedAt: null, isDisabled: false } }),
      this.db.client.count({ where: { deletedAt: null, isDisabled: true } }),
      this.db.client.count({
        where: { deletedAt: null, expiresAt: { lt: now } },
      }),
      this.db.client.count({
        where: { deletedAt: null, expiresAt: { gte: now, lte: in7d } },
      }),
      this.db.protocolConfiguration.groupBy({
        by: ["protocolId"],
        where: { deletedAt: null, isActive: true },
      }),
      this.db.subscription.count({
        where: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      this.db.runtimeHealthCheck.groupBy({
        by: ["protocolId"],
        where: {
          state: "running_verified",
          outcome: "passed",
          expiresAt: { gt: now },
        },
      }),
    ]);

    return {
      totalClients,
      activeClients,
      disabledClients,
      expiredClients,
      expiringClients7d: expiring,
      configuredProtocols: configGroups.length,
      verifiedRunningProtocols: verifiedGroups.length,
      activeSubscriptions: activeSubCount,
    };
  }
}

export interface EvaluatedStatus {
  state: RuntimeState;
  explanation: string | null;
  enforcementNote: string;
}

/**
 * Pure state evaluation, unit-tested independently of PostgreSQL.
 * `liveCheckState` may only be a state backed by a recorded, unexpired check.
 */
export function evaluateState(
  hasConfiguration: boolean,
  canHostInProcess: boolean,
  liveCheckState: RuntimeState | null
): EvaluatedStatus {
  if (!hasConfiguration) {
    return {
      state: "not_configured",
      explanation: "No active configuration for this protocol yet.",
      enforcementNote: "Nothing to enforce yet.",
    };
  }
  if (!canHostInProcess) {
    return {
      state: "runtime_unavailable",
      explanation:
        "Configuration is managed by the panel, but this process does not host the listener. " +
        "Run the protocol on a compatible external server.",
      enforcementNote: "external - enforced by the externally-hosted server, not by this panel.",
    };
  }
  if (liveCheckState === "running_verified") {
    return {
      state: "running_verified",
      explanation: null,
      enforcementNote: "runtime - verified by a live in-process health check.",
    };
  }
  if (liveCheckState === "degraded") {
    return {
      state: "degraded",
      explanation: null,
      enforcementNote: "runtime - partially available; a live check reported degraded service.",
    };
  }
  if (liveCheckState === "error" || liveCheckState === "stopped") {
    return {
      state: liveCheckState,
      explanation: null,
      enforcementNote: "runtime - the latest live check did not pass.",
    };
  }
  return {
    state: "awaiting_verification",
    explanation:
      "Configuration exists and the runtime may be supported, but no passing live health check is recorded.",
    enforcementNote: "runtime - awaiting live verification.",
  };
}

export type { EnforcementHint };
