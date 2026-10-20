import { useEffect, useState } from "react";
import type {
  ClientDTO,
  Paginated,
  SettingsResponse,
  SubscriptionDTO,
} from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  SkeletonTable,
  Spinner,
} from "../components/ui.js";
import { SubscriptionFormModal } from "../components/SubscriptionForm.js";

interface SubscriptionPage extends Paginated<SubscriptionDTO> {
  maxPerClientNote?: string;
}

export function SubscriptionsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { canOperate } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<SubscriptionPage | null>(null);
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [defaultFormat, setDefaultFormat] = useState<"xray_uri" | "raw_uri" | "singbox_json">(
    "xray_uri"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<SubscriptionDTO | null>(null);
  const [rotateTarget, setRotateTarget] = useState<SubscriptionDTO | null>(null);
  const [revealedUrl, setRevealedUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: "25",
        includeRevoked: includeRevoked ? "true" : "false",
      });
      const [subscriptions, clientData, settings] = await Promise.all([
        api.get<SubscriptionPage>(`/api/subscriptions?${query.toString()}`),
        api.get<Paginated<ClientDTO>>("/api/clients?page=1&pageSize=100&orderBy=label"),
        api.get<SettingsResponse>("/api/settings").catch(() => null),
      ]);
      setData(subscriptions);
      setClients(clientData.items);
      if (settings) setDefaultFormat(settings.settings.subscriptionDefaultFormat);
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, includeRevoked]);

  const statusOf = (subscription: SubscriptionDTO): { tone: string; label: string } => {
    if (subscription.revokedAt) return { tone: "badge-danger", label: t("subs.revokedAt") };
    if (subscription.expiresAt && new Date(subscription.expiresAt).getTime() <= Date.now()) {
      return { tone: "badge-warn", label: t("clients.statusExpired") };
    }
    return { tone: "badge-ok", label: t("common.active") };
  };

  const rotate = async () => {
    if (!rotateTarget) return;
    setBusy(true);
    try {
      const result = await api.post<{ url: string }>(
        `/api/subscriptions/${rotateTarget.id}/rotate`
      );
      setRevealedUrl(result.url);
      setRotateTarget(null);
      toast.success(t("subs.rotated"));
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      await api.post(`/api/subscriptions/${revokeTarget.id}/revoke`);
      toast.success(t("subs.revoked"));
      setRevokeTarget(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("subs.title")}
        subtitle={t("subs.subtitle")}
        actions={
          canOperate ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setCreateOpen(true)}
              disabled={clients.length === 0}
            >
              <Icon name="plus" className="h-4 w-4" />
              {t("subs.new")}
            </button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-surface-line bg-surface accent-accent"
            checked={includeRevoked}
            onChange={(event) => {
              setPage(1);
              setIncludeRevoked(event.target.checked);
            }}
          />
          {t("subs.showRevoked")}
        </label>
        <p className="text-[11px] text-ink-faint">{t("subs.urlNeverLogged")}</p>
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
            title={t("subs.empty")}
            description={t("subs.publicNote")}
            icon="subscriptions"
            action={
              canOperate && clients.length > 0 ? (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => setCreateOpen(true)}
                >
                  <Icon name="plus" className="h-4 w-4" />
                  {t("subs.new")}
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
                <th>{t("subs.name")}</th>
                <th>{t("subs.client")}</th>
                <th>{t("subs.format")}</th>
                <th>{t("common.status")}</th>
                <th>{t("subs.expiry")}</th>
                <th>{t("subs.accessCount")}</th>
                <th>{t("subs.lastAccess")}</th>
                <th className="text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((subscription) => {
                const status = statusOf(subscription);
                return (
                  <tr key={subscription.id}>
                    <td>
                      <p className="font-medium text-ink">{subscription.name}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-faint" dir="ltr">
                        {subscription.tokenHint}…
                      </p>
                    </td>
                    <td className="text-xs text-ink-muted">{subscription.clientLabel}</td>
                    <td className="text-xs text-ink-muted">
                      {t(`subs.format.${subscription.format}`)}
                    </td>
                    <td>
                      <span className={status.tone}>{status.label}</span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-ink-muted">
                      {subscription.expiresAt
                        ? formatDate(subscription.expiresAt)
                        : t("common.never")}
                    </td>
                    <td className="text-xs text-ink-muted">
                      {formatNumber(subscription.accessCount)}
                    </td>
                    <td className="whitespace-nowrap text-xs text-ink-muted">
                      {subscription.lastAccessAt
                        ? formatDate(subscription.lastAccessAt)
                        : t("common.never")}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        {canOperate && !subscription.revokedAt ? (
                          <>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => setRotateTarget(subscription)}
                            >
                              <Icon name="refresh" className="h-4 w-4" />
                              {t("subs.rotate")}
                            </button>
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              onClick={() => setRevokeTarget(subscription)}
                            >
                              <Icon name="ban" className="h-4 w-4" />
                              {t("subs.revoke")}
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-ink-faint">{t("subs.noUrl")}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
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

      <div className="mt-5">
        <Alert tone="warn" title={t("subs.publicNote")}>
          {t("subs.formatHint")} {t("subs.urlWarning")}
        </Alert>
      </div>

      <SubscriptionFormModal
        open={createOpen}
        clients={clients}
        defaultFormat={defaultFormat}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title={t("subs.revoke")}
        message={t("subs.revokeConfirm")}
        confirmLabel={t("subs.revoke")}
        loading={busy}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => void revoke()}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        title={t("subs.rotate")}
        message={t("subs.rotateConfirm")}
        confirmLabel={t("subs.rotate")}
        danger={false}
        loading={busy}
        onCancel={() => setRotateTarget(null)}
        onConfirm={() => void rotate()}
      />

      <Modal
        open={Boolean(revealedUrl)}
        onClose={() => setRevealedUrl("")}
        title={t("subs.newUrl")}
        description={t("subs.urlWarning")}
        size="lg"
        footer={
          <>
            <CopyButton value={revealedUrl} />
            <button type="button" className="btn-secondary" onClick={() => setRevealedUrl("")}>
              {t("common.close")}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="code-block select-all" dir="ltr">
            {revealedUrl}
          </div>
          <Alert tone="warn">{t("subs.urlWarning")}</Alert>
        </div>
      </Modal>
    </div>
  );
}
