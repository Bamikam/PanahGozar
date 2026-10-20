import { useEffect, useState } from "react";
import type { DiagnosticReportDTO, ProtocolCatalogResponse } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import {
  Alert,
  ErrorState,
  Icon,
  LoadingBlock,
  PageHeader,
  StatusBadge,
} from "../components/ui.js";

const SOURCES = [
  "https://docs.railway.com/networking/public-networking/specs-and-limits",
  "https://docs.railway.com/networking/tcp-proxy",
  "https://docs.railway.com/databases/build-a-database-service",
  "https://render.com/docs/web-services",
  "https://render.com/docs/health-checks",
  "https://render.com/docs/disks",
  "https://render.com/docs/postgresql-creating-connecting",
];

const ENV_VARS: { key: string; required: boolean; description: string }[] = [
  {
    key: "DATABASE_URL",
    required: true,
    description: "Managed PostgreSQL connection string (prefer the internal URL).",
  },
  {
    key: "SESSION_SECRET",
    required: true,
    description: "At least 32 random characters; never commit it.",
  },
  {
    key: "ENCRYPTION_KEY",
    required: true,
    description: "32-byte key: 64 hex chars or Render-generated base64.",
  },
  {
    key: "PUBLIC_URL",
    required: true,
    description: "Exact public https origin used in subscription links.",
  },
  {
    key: "SETUP_TOKEN",
    required: false,
    description: "Enables one-time first-administrator HTTP setup; empty disables it.",
  },
  {
    key: "PORT",
    required: false,
    description: "Assigned by Railway/Render; binds 0.0.0.0 inside the container.",
  },
  {
    key: "LOG_LEVEL",
    required: false,
    description: "fatal | error | warn | info | debug | trace.",
  },
  {
    key: "ENABLE_RUNTIME_LISTENERS",
    required: false,
    description: "Diagnostics switch. No protocol listener implementation exists here.",
  },
  {
    key: "COOKIE_SECURE",
    required: false,
    description: "auto | true | false. Keep auto with an https PUBLIC_URL.",
  },
];

export function DeploymentPage() {
  const { t, formatDate } = useI18n();
  const [catalog, setCatalog] = useState<ProtocolCatalogResponse | null>(null);
  const [diag, setDiag] = useState<DiagnosticReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [protocolData, diagnostics] = await Promise.all([
        api.get<ProtocolCatalogResponse>("/api/protocols"),
        api.get<DiagnosticReportDTO>("/api/diagnostics").catch(() => null),
      ]);
      setCatalog(protocolData);
      setDiag(diagnostics);
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

  return (
    <div>
      <PageHeader title={t("deploy.title")} subtitle={t("deploy.subtitle")} />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <div className="space-y-5">
          <Alert tone="warn" title={t("deploy.notice")}>
            {t("protocols.runtimeTruth")}
          </Alert>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="layers" className="h-4 w-4 text-accent" />
                <h2 className="section-title">{t("deploy.architecture")}</h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.architectureBody")}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px]">
                <div className="rounded-xl border border-surface-line bg-surface/50 p-3">
                  <p className="text-lg font-bold text-ink">1</p>
                  <p className="mt-1 text-ink-faint">GitHub repo</p>
                </div>
                <div className="rounded-xl border border-surface-line bg-surface/50 p-3">
                  <p className="text-lg font-bold text-ink">1</p>
                  <p className="mt-1 text-ink-faint">Web service</p>
                </div>
                <div className="rounded-xl border border-surface-line bg-surface/50 p-3">
                  <p className="text-lg font-bold text-ink">1</p>
                  <p className="mt-1 text-ink-faint">PostgreSQL</p>
                </div>
              </div>
            </section>

            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="shield" className="h-4 w-4 text-accent" />
                <h2 className="section-title">{t("deploy.health")}</h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.healthBody")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href="/api/health" target="_blank" rel="noreferrer" className="badge-accent">
                  /api/health
                </a>
                <a href="/api/ready" target="_blank" rel="noreferrer" className="badge-neutral">
                  /api/ready
                </a>
                <a href="/api/docs" target="_blank" rel="noreferrer" className="badge-neutral">
                  OpenAPI
                </a>
              </div>
              <p className="mt-3 text-[11px] text-ink-faint">
                {t("deploy.reviewDate")}: <span className="text-ink-muted">2026-10-20</span>
                {diag?.generatedAt ? ` · ${formatDate(diag.generatedAt)}` : ""}
              </p>
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="section-title">{t("deploy.compatibility")}</h2>
                <p className="mt-1 text-xs text-ink-muted">{t("deploy.lastReviewed")}</p>
              </div>
              <span className="badge-warn">{t("deploy.configOnly")}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("configs.protocol")}</th>
                    <th>{t("deploy.requirements")}</th>
                    <th>{t("deploy.runtime")}</th>
                    <th>{t("protocols.configurations")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(catalog?.protocols ?? []).map((protocol) => (
                    <tr key={protocol.id}>
                      <td>
                        <p className="text-sm font-medium text-ink">{protocol.displayName}</p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          {t(`protocols.category.${protocol.category}`)}
                        </p>
                      </td>
                      <td className="max-w-md text-xs leading-relaxed text-ink-muted">
                        {[
                          protocol.requiresInboundTcp ? "TCP inbound" : null,
                          protocol.requiresUdp ? "UDP" : null,
                          protocol.requiresRoot ? "Privileged/kernel support" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("common.none")}
                        <p className="mt-1 text-[11px] text-ink-faint">
                          {protocol.externalRuntimeNote}
                        </p>
                      </td>
                      <td>
                        {protocol.status ? <StatusBadge state={protocol.status.state} /> : null}
                        <p className="mt-1 text-[11px] text-ink-faint">{t("deploy.configOnly")}</p>
                      </td>
                      <td className="text-xs text-ink-muted">{protocol.configurationCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="server" className="h-4 w-4 text-accent" />
                <h2 className="section-title">
                  {t("deploy.platform")} · {t("deploy.railway")}
                </h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.railwayNotes")}
              </p>
            </section>
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="server" className="h-4 w-4 text-accent" />
                <h2 className="section-title">
                  {t("deploy.platform")} · {t("deploy.render")}
                </h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.renderNotes")}
              </p>
            </section>
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="globe" className="h-4 w-4 text-accent" />
                <h2 className="section-title">{t("deploy.database")}</h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.databaseNotes")}
              </p>
            </section>
            <section className="card p-5">
              <div className="flex items-center gap-2">
                <Icon name="external" className="h-4 w-4 text-warn" />
                <h2 className="section-title">{t("deploy.external")}</h2>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                {t("deploy.externalBody")}
              </p>
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <h2 className="section-title">{t("deploy.env")}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>{t("common.required")}</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {ENV_VARS.map((env) => (
                    <tr key={env.key}>
                      <td className="font-mono text-xs text-ink" dir="ltr">
                        {env.key}
                      </td>
                      <td>
                        {env.required ? (
                          <span className="badge-warn">{t("common.required")}</span>
                        ) : (
                          <span className="badge-neutral">{t("common.optional")}</span>
                        )}
                      </td>
                      <td className="text-xs leading-relaxed text-ink-muted">{env.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-surface-line px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
              {t("deploy.envBody")}
            </p>
          </section>

          <section className="card p-5">
            <h2 className="section-title">{t("deploy.docs")}</h2>
            <ul className="mt-3 grid gap-2 md:grid-cols-2">
              {SOURCES.map((source) => (
                <li key={source}>
                  <a
                    href={source}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-2 text-xs text-accent hover:underline"
                    dir="ltr"
                  >
                    <Icon name="external" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">{source}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
              {diag?.compatibilityReview
                ? t("diag.reviewed", { date: diag.compatibilityReview.reviewedAt })
                : t("deploy.lastReviewed")}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
