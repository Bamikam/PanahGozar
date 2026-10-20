import { useEffect, useState } from "react";
import type { AuditEventDTO, Paginated } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import {
  EmptyState,
  ErrorState,
  Icon,
  LoadingBlock,
  PageHeader,
  Pagination,
  SkeletonTable,
} from "../components/ui.js";
import { humanizeAction } from "../lib/format.js";

export function AuditPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const [data, setData] = useState<Paginated<AuditEventDTO> | null>(null);
  const [page, setPage] = useState(1);
  const [actionInput, setActionInput] = useState("");
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (action) params.set("action", action);
      setData(await api.get<Paginated<AuditEventDTO>>(`/api/audit?${params.toString()}`));
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, action]);

  return (
    <div>
      <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} />

      <div className="card mb-5 p-4">
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAction(actionInput.trim());
          }}
        >
          <div className="relative flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            />
            <input
              className="input ps-9"
              value={actionInput}
              onChange={(event) => setActionInput(event.target.value)}
              placeholder={t("audit.filterAction")}
              aria-label={t("audit.filterAction")}
              dir="ltr"
            />
          </div>
          <button type="submit" className="btn-secondary">
            <Icon name="search" className="h-4 w-4" />
            {t("common.filter")}
          </button>
          {action ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setActionInput("");
                setAction("");
                setPage(1);
              }}
            >
              {t("common.clear")}
            </button>
          ) : null}
        </form>
      </div>

      {loading ? (
        <div className="table-wrap">
          <SkeletonTable rows={8} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <EmptyState title={t("audit.empty")} icon="audit" />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("audit.action")}</th>
                <th>{t("audit.actor")}</th>
                <th>{t("audit.target")}</th>
                <th>{t("audit.ip")}</th>
                <th>{t("audit.when")}</th>
                <th className="text-end">{t("audit.meta")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <p className="text-sm font-medium text-ink">{humanizeAction(event.action)}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-faint" dir="ltr">
                      {event.action}
                    </p>
                  </td>
                  <td className="text-xs text-ink-muted">{event.actorLabel ?? "system"}</td>
                  <td>
                    <span className="badge-neutral">{event.targetType}</span>
                    <p
                      className="mt-1 max-w-[140px] truncate font-mono text-[10px] text-ink-faint"
                      dir="ltr"
                    >
                      {event.targetId}
                    </p>
                  </td>
                  <td className="whitespace-nowrap font-mono text-[11px] text-ink-muted" dir="ltr">
                    {event.ip ?? "—"}
                  </td>
                  <td className="whitespace-nowrap text-[11px] text-ink-muted">
                    {formatDate(event.createdAt)}
                  </td>
                  <td className="text-end">
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                    >
                      {expanded === event.id ? t("common.hide") : t("common.show")}
                    </button>
                    {expanded === event.id ? (
                      <pre className="code-block mt-2 max-w-xs text-[10px]" dir="ltr">
                        {JSON.stringify(event.meta, null, 2)}
                      </pre>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onChange={setPage}
          />
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        {t("audit.redaction")} · {t("common.total", { count: formatNumber(data?.total ?? 0) })}
      </p>
    </div>
  );
}
