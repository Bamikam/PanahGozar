import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { DiagnosticReportDTO } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ErrorState,
  Icon,
  InfoRow,
  LoadingBlock,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";

export function DiagnosticsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const toast = useToast();
  const [report, setReport] = useState<DiagnosticReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      setReport(await api.get<DiagnosticReportDTO>("/api/diagnostics"));
      if (refresh) toast.success(t("diag.refreshed"));
    } catch (err) {
      setError(apiErrorMessage(err, t("diag.error")));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, DiagnosticReportDTO["checks"]>();
    for (const check of report?.checks ?? []) {
      const group = check.key.includes(".") ? (check.key.split(".")[0] ?? "general") : "general";
      const list = map.get(group) ?? [];
      list.push(check);
      map.set(group, list);
    }
    return [...map.entries()];
  }, [report]);

  const yesNo = (value: boolean | null | undefined) =>
    value === true ? t("diag.yes") : value === false ? t("diag.no") : t("diag.unknown");

  return (
    <div>
      <PageHeader
        title={t("diag.title")}
        subtitle={t("diag.subtitle")}
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? <Spinner /> : <Icon name="refresh" className="h-4 w-4" />}
            {t("common.refresh")}
          </button>
        }
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : report ? (
        <div className="space-y-5">
          <Alert tone="warn" title={t("diag.falseRuntime")}>
            {t("protocols.runtimeTruth")}
          </Alert>

          <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
            <section className="card">
              <div className="card-header">
                <h2 className="section-title">{t("diag.environment")}</h2>
                <span className="text-[11px] text-ink-faint">{formatDate(report.generatedAt)}</span>
              </div>
              <dl className="px-5 py-2">
                <InfoRow
                  label={t("diag.node")}
                  value={<span dir="ltr">{report.nodeVersion}</span>}
                />
                <InfoRow label={t("diag.platform")} value={`${report.platform} · ${report.arch}`} />
                <InfoRow
                  label={t("diag.user")}
                  value={<span dir="ltr">{report.processUser}</span>}
                />
                <InfoRow label={t("diag.container")} value={yesNo(report.isContainer)} />
                <InfoRow label={t("diag.cwdWritable")} value={yesNo(report.cwdWritable)} />
                <InfoRow
                  label={t("diag.database")}
                  value={
                    <span className={report.databaseReachable ? "text-ok" : "text-danger"}>
                      {report.databaseReachable ? t("diag.yes") : t("diag.no")}
                    </span>
                  }
                />
                <InfoRow
                  label={t("diag.migrations")}
                  value={
                    <span className={report.allMigrationsApplied ? "text-ok" : "text-danger"}>
                      {report.allMigrationsApplied ? t("diag.yes") : t("diag.no")}
                    </span>
                  }
                />
                <InfoRow
                  label={t("diag.listeners")}
                  value={
                    report.runtimeListenersEnabled ? (
                      <span className="badge-warn">{t("common.active")}</span>
                    ) : (
                      <span className="badge-neutral">{t("common.inactive")}</span>
                    )
                  }
                />
                <InfoRow label={t("diag.model")} value={report.deploymentModel ?? "—"} />
              </dl>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="section-title">{t("diag.protocolStatus")}</h2>
                  <p className="mt-1 text-xs text-ink-muted">
                    {t("diag.summary", {
                      available: formatNumber(report.checksSummary.available),
                      unavailable: formatNumber(report.checksSummary.unavailable),
                      total: formatNumber(report.checksSummary.total),
                    })}
                  </p>
                </div>
                <Link to="/deployment" className="btn-ghost btn-sm">
                  {t("nav.deployment")}
                  <Icon name="chevron-right" className="h-4 w-4 rtl:rotate-180" />
                </Link>
              </div>
              <div className="divide-y divide-surface-line/70">
                {report.protocols.map((protocol) => (
                  <div key={protocol.protocolId} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-ink">{protocol.displayName}</p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          {protocol.configurationCount} {t("protocols.configurations")} ·{" "}
                          {protocol.lastHealthCheck
                            ? `${t("diag.lastCheck")}: ${formatDate(protocol.lastHealthCheck.recordedAt)}`
                            : t("diag.noCheck")}
                        </p>
                      </div>
                      <StatusBadge state={protocol.state} />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                      {protocol.explanation}
                    </p>
                    <p className="mt-1 text-[11px] text-warn">{protocol.enforcementNote}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <h2 className="section-title">{t("diag.checks")}</h2>
              <span className="badge-neutral">
                {t("diag.summary", {
                  available: formatNumber(report.checksSummary.available),
                  unavailable: formatNumber(report.checksSummary.unavailable),
                  total: formatNumber(report.checksSummary.total),
                })}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("diag.checkName")}</th>
                    <th>{t("common.status")}</th>
                    <th>{t("diag.reason")}</th>
                    <th>{t("diag.checkedAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.checks.map((check) => (
                    <tr key={check.key}>
                      <td>
                        <p className="text-sm text-ink">{check.label}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-faint" dir="ltr">
                          {check.key}
                        </p>
                      </td>
                      <td>
                        {check.available ? (
                          <span className="badge-ok">{t("diag.available")}</span>
                        ) : (
                          <span className="badge-warn">{t("diag.unavailable")}</span>
                        )}
                      </td>
                      <td className="max-w-md text-xs leading-relaxed text-ink-muted">
                        {check.reason}
                        {check.evidence ? (
                          <p className="mt-1 font-mono text-[10px] text-ink-faint" dir="ltr">
                            {check.evidence}
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap text-[11px] text-ink-faint">
                        {formatDate(check.checkedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="shield" className="h-4 w-4 text-accent" />
                <h2 className="section-title">{t("deploy.health")}</h2>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                {t("deploy.healthBody")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px]">
                <a href="/api/health" target="_blank" rel="noreferrer" className="badge-accent">
                  /api/health
                </a>
                <a href="/api/ready" target="_blank" rel="noreferrer" className="badge-neutral">
                  /api/ready
                </a>
              </div>
            </section>
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="external" className="h-4 w-4 text-accent" />
                <h2 className="section-title">{t("diag.reviewSources")}</h2>
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                {t("diag.reviewed", {
                  date: report.compatibilityReview?.reviewedAt ?? "2026-10-19",
                })}
              </p>
              <ul className="mt-3 space-y-1.5">
                {(report.compatibilityReview?.sources ?? []).map((source) => (
                  <li key={source}>
                    <a
                      href={source}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-[11px] text-accent hover:underline"
                      dir="ltr"
                    >
                      {source}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
