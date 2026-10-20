import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardStatsDTO } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { Alert, ErrorState, Icon, LoadingBlock, PageHeader } from "../components/ui.js";
import { humanizeAction } from "../lib/format.js";

interface StatCard {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Icon>["name"];
  tone: string;
  hint?: string;
}

export function OverviewPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { user } = useAuth();
  const [data, setData] = useState<DashboardStatsDTO | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<DashboardStatsDTO>("/api/dashboard"));
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards: StatCard[] = data
    ? [
        {
          label: t("overview.totalClients"),
          value: formatNumber(data.totalClients),
          icon: "clients",
          tone: "text-accent",
          hint: `${formatNumber(data.activeClients)} ${t("common.active")} · ${formatNumber(data.disabledClients)} ${t("common.inactive")}`,
        },
        {
          label: t("overview.expiringClients"),
          value: formatNumber(data.expiringWithinDays.clients),
          icon: "clock",
          tone: "text-warn",
          hint: `${formatNumber(data.expiredClients)} ${t("clients.statusExpired")}`,
        },
        {
          label: t("overview.configuredProtocols"),
          value: formatNumber(data.configuredProtocols),
          icon: "protocols",
          tone: "text-accent",
        },
        {
          label: t("overview.verifiedRunning"),
          value: formatNumber(data.verifiedRunningProtocols),
          icon: "activity",
          tone: data.verifiedRunningProtocols > 0 ? "text-ok" : "text-ink-muted",
          hint: t("overview.zeroVerified"),
        },
        {
          label: t("overview.subscriptions"),
          value: formatNumber(data.activeSubscriptions),
          icon: "subscriptions",
          tone: "text-accent",
        },
        {
          label: t("overview.disabledClients"),
          value: formatNumber(data.disabledClients),
          icon: "ban",
          tone: "text-ink-muted",
        },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        subtitle={t("overview.subtitle")}
        actions={
          <>
            <Link to="/clients" className="btn-secondary">
              <Icon name="clients" className="h-4 w-4" />
              {t("nav.clients")}
            </Link>
            <Link to="/configurations" className="btn-primary">
              <Icon name="plus" className="h-4 w-4" />
              {t("configs.new")}
            </Link>
          </>
        }
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card, index) => (
              <div
                key={card.label}
                className="card animate-fade-up p-5"
                style={{ animationDelay: `${index * 35}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                      {card.label}
                    </p>
                    <p className="stat-value">{card.value}</p>
                  </div>
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-xl bg-surface-overlay ${card.tone}`}
                  >
                    <Icon name={card.icon} className="h-5 w-5" />
                  </div>
                </div>
                {card.hint ? (
                  <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{card.hint}</p>
                ) : null}
              </div>
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="section-title">{t("overview.recentEvents")}</h2>
                  <p className="mt-1 text-xs text-ink-muted">{t("audit.redaction")}</p>
                </div>
                {user?.role === "admin" ? (
                  <Link to="/audit" className="btn-ghost btn-sm">
                    {t("nav.audit")}
                    <Icon name="chevron-right" className="h-4 w-4 rtl:rotate-180" />
                  </Link>
                ) : null}
              </div>
              {data.recentEvents.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-ink-muted">
                  {t("overview.noEvents")}
                </div>
              ) : (
                <ul className="divide-y divide-surface-line/70">
                  {data.recentEvents.map((event) => (
                    <li key={event.id} className="flex items-start gap-3 px-5 py-3.5">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-overlay text-ink-muted">
                        <Icon name="activity" className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">
                          {humanizeAction(event.action)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          {event.actorLabel ?? "system"} · {formatDate(event.createdAt)}
                        </p>
                      </div>
                      <span className="badge-neutral hidden sm:inline-flex">
                        {event.targetType}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-5">
              <div className="card p-5">
                <div className="flex items-center gap-2">
                  <Icon name="server" className="h-4 w-4 text-warn" />
                  <h2 className="section-title">{t("deploy.architecture")}</h2>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-ink-muted">{data.runtimeNote}</p>
                <Link to="/diagnostics" className="btn-secondary btn-sm mt-4">
                  <Icon name="diagnostics" className="h-4 w-4" />
                  {t("overview.runtimeBannerAction")}
                </Link>
              </div>

              <div className="card p-5">
                <h2 className="section-title">{t("overview.quickStart")}</h2>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  {t("overview.quickStartDesc")}
                </p>
                <ol className="mt-4 space-y-3">
                  {[
                    {
                      key: "overview.stepProtocol",
                      to: "/configurations",
                      done: data.configuredProtocols > 0,
                    },
                    { key: "overview.stepClient", to: "/clients", done: data.totalClients > 0 },
                    {
                      key: "overview.stepAssign",
                      to: "/clients",
                      done: data.totalClients > 0 && data.configuredProtocols > 0,
                    },
                    {
                      key: "overview.stepSubscribe",
                      to: "/subscriptions",
                      done: data.activeSubscriptions > 0,
                    },
                  ].map((step, index) => (
                    <li key={step.key} className="flex items-center gap-3">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                          step.done
                            ? "border-ok/30 bg-ok/10 text-ok"
                            : "border-surface-line bg-surface text-ink-faint"
                        }`}
                      >
                        {step.done ? <Icon name="check" className="h-3 w-3" /> : index + 1}
                      </span>
                      <Link to={step.to} className="text-xs text-ink-muted hover:text-accent">
                        {t(step.key)}
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>

          <Alert tone="info" title={t("overview.noStatistics")}>
            <p>{t("overview.limitTruth")}</p>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
