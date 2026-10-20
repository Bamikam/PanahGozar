import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ProtocolCatalogResponse } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { ErrorState, Icon, LoadingBlock, PageHeader, StatusBadge } from "../components/ui.js";

const CATEGORY_ORDER = ["xray_proxy", "proxy", "vpn", "integration"] as const;

export function ProtocolsPage() {
  const { t, formatNumber } = useI18n();
  const { canOperate } = useAuth();
  const [data, setData] = useState<ProtocolCatalogResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<ProtocolCatalogResponse>("/api/protocols"));
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

  const grouped = useMemo(() => {
    const map = new Map<string, ProtocolCatalogResponse["protocols"]>();
    for (const protocol of data?.protocols ?? []) {
      const list = map.get(protocol.category) ?? [];
      list.push(protocol);
      map.set(protocol.category, list);
    }
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: map.get(category) ?? [],
    })).filter((group) => group.items.length > 0);
  }, [data]);

  return (
    <div>
      <PageHeader
        title={t("protocols.title")}
        subtitle={t("protocols.subtitle")}
        actions={
          <a href="/api/docs" target="_blank" rel="noreferrer" className="btn-secondary">
            <Icon name="external" className="h-4 w-4" />
            API docs
          </a>
        }
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data ? (
        <div className="space-y-8">
          <div className="alert-info">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{t("protocols.runtimeTruth")}</p>
          </div>

          {grouped.map((group) => (
            <section key={group.category} aria-labelledby={`category-${group.category}`}>
              <div className="mb-3 flex items-center gap-3">
                <h2 id={`category-${group.category}`} className="section-title">
                  {t(`protocols.category.${group.category}`)}
                </h2>
                <span className="badge-neutral">{formatNumber(group.items.length)}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map((protocol) => (
                  <article key={protocol.id} className="card flex flex-col p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-overlay text-accent">
                          <Icon
                            name={
                              protocol.category === "vpn"
                                ? "shield"
                                : protocol.category === "integration"
                                  ? "globe"
                                  : "protocols"
                            }
                            className="h-5 w-5"
                          />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-ink">{protocol.displayName}</h3>
                          <p className="mt-0.5 text-[11px] text-ink-faint">{protocol.id}</p>
                        </div>
                      </div>
                      {protocol.status ? <StatusBadge state={protocol.status.state} /> : null}
                    </div>

                    <p className="mt-3 flex-1 text-xs leading-relaxed text-ink-muted">
                      {protocol.description}
                    </p>

                    <dl className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
                      <div className="rounded-lg border border-surface-line bg-surface/50 px-2.5 py-2">
                        <dt className="text-ink-faint">{t("protocols.configurations")}</dt>
                        <dd className="mt-0.5 font-semibold text-ink">
                          {formatNumber(protocol.configurationCount)}
                        </dd>
                      </div>
                      <div className="rounded-lg border border-surface-line bg-surface/50 px-2.5 py-2">
                        <dt className="text-ink-faint">{t("protocols.requirements")}</dt>
                        <dd className="mt-0.5 font-semibold text-ink">
                          {[
                            protocol.requiresInboundTcp ? "TCP" : null,
                            protocol.requiresUdp ? "UDP" : null,
                            protocol.requiresRoot ? "root" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || t("common.none")}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {canOperate ? (
                        <Link
                          to={`/configurations?protocol=${encodeURIComponent(protocol.id)}&new=1`}
                          className="btn-primary btn-sm"
                        >
                          <Icon name="plus" className="h-4 w-4" />
                          {t("protocols.createConfig")}
                        </Link>
                      ) : null}
                      {protocol.docsUrl ? (
                        <a
                          href={protocol.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-ghost btn-sm"
                        >
                          <Icon name="external" className="h-4 w-4" />
                          {t("protocols.docs")}
                        </a>
                      ) : null}
                    </div>
                    <p className="mt-3 border-t border-surface-line pt-3 text-[11px] leading-relaxed text-warn">
                      {protocol.externalRuntimeNote}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ))}

          <section aria-labelledby="integration-heading">
            <h2 id="integration-heading" className="section-title mb-3">
              {t("protocols.integrationFormats")}
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              {data.integrationFormats.map((format) => (
                <div key={format.id} className="card p-5">
                  <div className="flex items-center gap-2">
                    <Icon name="layers" className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-ink">{format.name}</h3>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                    {format.description}
                  </p>
                  <p className="mt-3 text-[11px] leading-relaxed text-warn">{format.runtimeNote}</p>
                  <a
                    href={format.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost btn-sm mt-3"
                  >
                    <Icon name="external" className="h-4 w-4" />
                    {t("protocols.docs")}
                  </a>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
