import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ClientDTO, Paginated } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  ClientStatusBadge,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Pagination,
  SkeletonTable,
  Spinner,
} from "../components/ui.js";
import { ClientFormModal } from "../components/ClientForm.js";
import { formatBytes } from "../lib/format.js";

type ConfirmAction =
  { kind: "revoke"; client: ClientDTO } | { kind: "delete"; client: ClientDTO } | null;

export function ClientsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { canOperate, isAdmin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Paginated<ClientDTO> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState({ page: 1, search: "", status: "", orderBy: "createdAt" });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClientDTO | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pageSize = 20;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        page: String(query.page),
        pageSize: String(pageSize),
        orderBy: query.orderBy,
      });
      if (query.search) params.set("search", query.search);
      if (query.status === "active") params.set("disabled", "false");
      if (query.status === "disabled") params.set("disabled", "true");
      setData(await api.get<Paginated<ClientDTO>>(`/api/clients?${params.toString()}`));
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.search, query.status, query.orderBy]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (client: ClientDTO) => {
    setEditing(client);
    setFormOpen(true);
  };

  const setDisabled = async (client: ClientDTO, disabled: boolean) => {
    setBusyId(client.id);
    try {
      await api.patch(`/api/clients/${client.id}`, { isDisabled: disabled });
      toast.success(t("clients.updated"));
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyId(null);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusyId(confirm.client.id);
    try {
      if (confirm.kind === "delete") {
        await api.del(`/api/clients/${confirm.client.id}`);
        toast.success(t("clients.deleted"));
      } else {
        await api.post(`/api/clients/${confirm.client.id}/revoke`);
        toast.success(t("clients.revokedNotice"));
      }
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("clients.title")}
        subtitle={t("clients.subtitle")}
        actions={
          canOperate ? (
            <button type="button" className="btn-primary" onClick={openCreate}>
              <Icon name="plus" className="h-4 w-4" />
              {t("clients.new")}
            </button>
          ) : null
        }
      />

      <div className="card mb-5 p-4">
        <form
          className="flex flex-col gap-3 lg:flex-row lg:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery((current) => ({ ...current, page: 1, search: searchInput.trim() }));
          }}
        >
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="client-search">
              {t("common.search")}
            </label>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              />
              <input
                id="client-search"
                className="input ps-9"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder={t("clients.searchPlaceholder")}
              />
            </div>
          </div>
          <div className="w-full sm:w-44">
            <label className="label" htmlFor="client-status">
              {t("common.status")}
            </label>
            <select
              id="client-status"
              className="select"
              value={query.status}
              onChange={(event) =>
                setQuery((current) => ({ ...current, page: 1, status: event.target.value }))
              }
            >
              <option value="">{t("clients.allStatuses")}</option>
              <option value="active">{t("clients.activeOnly")}</option>
              <option value="disabled">{t("clients.disabledOnly")}</option>
            </select>
          </div>
          <div className="w-full sm:w-44">
            <label className="label" htmlFor="client-sort">
              {t("common.filter")}
            </label>
            <select
              id="client-sort"
              className="select"
              value={query.orderBy}
              onChange={(event) =>
                setQuery((current) => ({ ...current, page: 1, orderBy: event.target.value }))
              }
            >
              <option value="createdAt">{t("clients.sortNewest")}</option>
              <option value="label">{t("clients.sortLabel")}</option>
              <option value="expiresAt">{t("clients.sortExpiry")}</option>
            </select>
          </div>
          <button type="submit" className="btn-secondary">
            <Icon name="search" className="h-4 w-4" />
            {t("common.search")}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="table-wrap">
          <SkeletonTable />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t("clients.empty")}
            description={t("clients.subtitle")}
            icon="clients"
            action={
              canOperate ? (
                <button type="button" className="btn-primary btn-sm" onClick={openCreate}>
                  <Icon name="plus" className="h-4 w-4" />
                  {t("clients.createFirst")}
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("clients.label")}</th>
                <th>{t("common.status")}</th>
                <th>{t("clients.expiryLabel")}</th>
                <th>{t("clients.trafficQuota")}</th>
                <th>{t("clients.tagsLabel")}</th>
                <th>{t("clients.subscriptions")}</th>
                <th className="text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((client) => (
                <tr key={client.id}>
                  <td>
                    <Link
                      to={`/clients/${client.id}`}
                      className="font-medium text-ink hover:text-accent"
                    >
                      {client.label}
                    </Link>
                    {client.email ? (
                      <p className="mt-0.5 text-[11px] text-ink-faint" dir="ltr">
                        {client.email}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <ClientStatusBadge
                      isDisabled={client.isDisabled}
                      isExpired={Boolean(client.isExpired)}
                    />
                  </td>
                  <td className="whitespace-nowrap text-xs text-ink-muted">
                    {client.expiresAt ? formatDate(client.expiresAt) : t("common.never")}
                  </td>
                  <td className="text-xs text-ink-muted">
                    {client.trafficQuotaBytes
                      ? `${formatBytes(client.trafficQuotaBytes)} · ${t("clients.quotaUnavailable")}`
                      : "—"}
                  </td>
                  <td>
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      {client.tags.length > 0 ? (
                        client.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="badge-neutral normal-case tracking-normal">
                            {tag}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                      {client.tags.length > 3 ? (
                        <span className="text-[11px] text-ink-faint">
                          +{client.tags.length - 3}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="text-xs text-ink-muted">
                    {formatNumber(client.subscriptionCount ?? 0)}
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        to={`/clients/${client.id}`}
                        className="icon-btn"
                        title={t("common.details")}
                        aria-label={t("common.details")}
                      >
                        <Icon name="eye" className="h-4 w-4" />
                      </Link>
                      {canOperate ? (
                        <>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => openEdit(client)}
                            title={t("common.edit")}
                            aria-label={t("common.edit")}
                          >
                            <Icon name="edit" className="h-4 w-4" />
                          </button>
                          {client.isDisabled ? (
                            <button
                              type="button"
                              className="icon-btn text-ok"
                              onClick={() => void setDisabled(client, false)}
                              title={t("common.enable")}
                              aria-label={t("common.enable")}
                              disabled={busyId === client.id}
                            >
                              {busyId === client.id ? (
                                <Spinner />
                              ) : (
                                <Icon name="check" className="h-4 w-4" />
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => void setDisabled(client, true)}
                              title={t("common.disable")}
                              aria-label={t("common.disable")}
                              disabled={busyId === client.id}
                            >
                              {busyId === client.id ? (
                                <Spinner />
                              ) : (
                                <Icon name="ban" className="h-4 w-4" />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn text-warn"
                            onClick={() => setConfirm({ kind: "revoke", client })}
                            title={t("clients.revoke")}
                            aria-label={t("clients.revoke")}
                          >
                            <Icon name="key" className="h-4 w-4" />
                          </button>
                          {isAdmin ? (
                            <button
                              type="button"
                              className="icon-btn text-danger"
                              onClick={() => setConfirm({ kind: "delete", client })}
                              title={t("common.delete")}
                              aria-label={t("common.delete")}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onChange={(page) => setQuery((current) => ({ ...current, page }))}
          />
        </div>
      )}

      <ClientFormModal
        open={formOpen}
        client={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void load()}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "delete" ? t("common.delete") : t("clients.revoke")}
        message={
          confirm?.kind === "delete" ? t("clients.deleteConfirm") : t("clients.revokedConfirm")
        }
        confirmLabel={confirm?.kind === "delete" ? t("common.delete") : t("clients.revoke")}
        loading={busyId !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
