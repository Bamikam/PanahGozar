import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  ClientAssignmentDTO,
  ClientDetailDTO,
  ConfigurationDTO,
  Paginated,
  SubscriptionDTO,
} from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ClientStatusBadge,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InfoRow,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
} from "../components/ui.js";
import { ClientFormModal } from "../components/ClientForm.js";
import { SubscriptionFormModal } from "../components/SubscriptionForm.js";
import { formatBytes } from "../lib/format.js";

type ConfirmState =
  | { kind: "unassign" | "rotate" | "revokeCredential"; assignment: ClientAssignmentDTO }
  | { kind: "revokeClient" | "deleteClient" }
  | null;

interface UriModalState {
  open: boolean;
  loading: boolean;
  title: string;
  content: string;
  uri: string | null;
}

interface QrModalState {
  open: boolean;
  loading: boolean;
  title: string;
  objectUrl: string;
  error: string;
}

export function ClientDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { t, formatDate, formatNumber } = useI18n();
  const { canOperate, isAdmin } = useAuth();
  const toast = useToast();

  const [client, setClient] = useState<ClientDetailDTO | null>(null);
  const [configs, setConfigs] = useState<ConfigurationDTO[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignConfigId, setAssignConfigId] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [uriModal, setUriModal] = useState<UriModalState>({
    open: false,
    loading: false,
    title: "",
    content: "",
    uri: null,
  });
  const [qrModal, setQrModal] = useState<QrModalState>({
    open: false,
    loading: false,
    title: "",
    objectUrl: "",
    error: "",
  });
  const [busyKey, setBusyKey] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [clientResult, configResult, subResult] = await Promise.all([
        api.get<ClientDetailDTO>(`/api/clients/${id}`),
        api.get<ConfigurationDTO[]>("/api/configurations"),
        api.get<Paginated<SubscriptionDTO>>(
          `/api/subscriptions?clientId=${encodeURIComponent(id)}&pageSize=100&includeRevoked=true`
        ),
      ]);
      setClient(clientResult);
      setConfigs(configResult);
      setSubscriptions(subResult.items);
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    return () => {
      if (qrModal.objectUrl) URL.revokeObjectURL(qrModal.objectUrl);
    };
  }, [qrModal.objectUrl]);

  const activeAssignments = useMemo(
    () => (client?.assignments ?? []).filter((assignment) => !assignment.revokedAt),
    [client]
  );
  const historyAssignments = useMemo(
    () => (client?.assignments ?? []).filter((assignment) => assignment.revokedAt),
    [client]
  );
  const assignable = useMemo(
    () =>
      configs.filter(
        (config) =>
          config.isActive &&
          !activeAssignments.some((assignment) => assignment.configurationId === config.id)
      ),
    [configs, activeAssignments]
  );

  const toggleDisabled = async (disabled: boolean) => {
    setBusyKey("status");
    try {
      await api.patch(`/api/clients/${id}`, { isDisabled: disabled });
      toast.success(t("clients.updated"));
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const assign = async () => {
    if (!assignConfigId) return;
    setAssignBusy(true);
    try {
      await api.post(`/api/clients/${id}/assign`, { configurationId: assignConfigId });
      toast.success(t("clients.assigned"));
      setAssignOpen(false);
      setAssignConfigId("");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setAssignBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      if (
        confirm.kind === "unassign" ||
        confirm.kind === "rotate" ||
        confirm.kind === "revokeCredential"
      ) {
        const configId = confirm.assignment.configurationId;
        if (confirm.kind === "unassign") {
          await api.post(`/api/clients/${id}/unassign`, { configurationId: configId });
          toast.success(t("clients.unassigned"));
        } else if (confirm.kind === "rotate") {
          await api.post(`/api/clients/${id}/rotate-credential`, { configurationId: configId });
          toast.success(t("clients.rotated"));
        } else {
          await api.post(`/api/clients/${id}/revoke-credential`, { configurationId: configId });
          toast.success(t("clients.credentialRevoked"));
        }
      } else if (confirm.kind === "revokeClient") {
        await api.post(`/api/clients/${id}/revoke`);
        toast.success(t("clients.revokedNotice"));
      } else {
        await api.del(`/api/clients/${id}`);
        toast.success(t("clients.deleted"));
        navigate("/clients");
        return;
      }
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setConfirmBusy(false);
    }
  };

  const exportArtifact = async (assignment: ClientAssignmentDTO) => {
    setBusyKey(`export:${assignment.credentialId}`);
    try {
      await api.download(
        `/api/clients/${id}/export/${assignment.configurationId}`,
        `${assignment.protocolId}-${client?.label ?? "client"}.txt`
      );
      toast.success(t("clients.exported"));
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const viewUri = async (assignment: ClientAssignmentDTO) => {
    setUriModal({
      open: true,
      loading: true,
      title: assignment.configurationName,
      content: "",
      uri: null,
    });
    try {
      const result = await api.get<{ uri: string | null; content: string }>(
        `/api/clients/${id}/uri/${assignment.configurationId}`
      );
      setUriModal({
        open: true,
        loading: false,
        title: assignment.configurationName,
        content: result.content,
        uri: result.uri,
      });
    } catch (err) {
      setUriModal({
        open: true,
        loading: false,
        title: assignment.configurationName,
        content: apiErrorMessage(err, t("common.error")),
        uri: null,
      });
    }
  };

  const viewQr = async (assignment: ClientAssignmentDTO) => {
    if (qrModal.objectUrl) URL.revokeObjectURL(qrModal.objectUrl);
    setQrModal({
      open: true,
      loading: true,
      title: assignment.configurationName,
      objectUrl: "",
      error: "",
    });
    try {
      const blob = await api.getBlob(`/api/clients/${id}/qr/${assignment.configurationId}`);
      setQrModal({
        open: true,
        loading: false,
        title: assignment.configurationName,
        objectUrl: URL.createObjectURL(blob),
        error: "",
      });
    } catch (err) {
      setQrModal({
        open: true,
        loading: false,
        title: assignment.configurationName,
        objectUrl: "",
        error: apiErrorMessage(err, t("common.error")),
      });
    }
  };

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!client) {
    return (
      <div className="card">
        <EmptyState title={t("clients.notFound")} icon="clients" />
      </div>
    );
  }

  const statusBadge = (
    <ClientStatusBadge isDisabled={client.isDisabled} isExpired={Boolean(client.isExpired)} />
  );

  return (
    <div>
      <Link to="/clients" className="btn-ghost btn-sm mb-3 -ms-2">
        <Icon name="arrow-left" className="h-4 w-4 rtl:rotate-180" />
        {t("clients.backToClients")}
      </Link>
      <PageHeader
        title={client.label}
        subtitle={client.email ?? t("clients.detailTitle")}
        actions={
          <>
            {statusBadge}
            {canOperate ? (
              <>
                <button type="button" className="btn-secondary" onClick={() => setEditOpen(true)}>
                  <Icon name="edit" className="h-4 w-4" />
                  {t("common.edit")}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setAssignConfigId(assignable[0]?.id ?? "");
                    setAssignOpen(true);
                  }}
                  disabled={assignable.length === 0}
                >
                  <Icon name="plus" className="h-4 w-4" />
                  {t("clients.assign")}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => setConfirm({ kind: "revokeClient" })}
                >
                  <Icon name="ban" className="h-4 w-4" />
                  {t("clients.revoke")}
                </button>
              </>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setConfirm({ kind: "deleteClient" })}
              >
                <Icon name="trash" className="h-4 w-4" />
                {t("common.delete")}
              </button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_2fr]">
        <div className="space-y-5">
          <section className="card">
            <div className="card-header">
              <h2 className="section-title">{t("clients.profile")}</h2>
            </div>
            <dl className="px-5 py-2">
              <InfoRow label={t("clients.label")} value={client.label} />
              <InfoRow label={t("clients.email")} value={client.email ?? "—"} />
              <InfoRow
                label={t("clients.tagsLabel")}
                value={
                  client.tags.length > 0 ? (
                    <span className="flex flex-wrap justify-end gap-1">
                      {client.tags.map((tag) => (
                        <span key={tag} className="badge-neutral normal-case tracking-normal">
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <InfoRow label={t("common.created")} value={formatDate(client.createdAt)} />
              <InfoRow label={t("common.updated")} value={formatDate(client.updatedAt)} />
              <InfoRow
                label={t("clients.expiryLabel")}
                value={client.expiresAt ? formatDate(client.expiresAt) : t("common.never")}
              />
              <InfoRow
                label={t("clients.quotaLabel")}
                value={client.trafficQuotaBytes ? formatBytes(client.trafficQuotaBytes) : "—"}
              />
              <InfoRow
                label={t("clients.subscriptions")}
                value={formatNumber(client.subscriptionCount ?? subscriptions.length)}
              />
              {canOperate ? (
                <InfoRow
                  label={t("common.status")}
                  value={
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      disabled={busyKey === "status"}
                      onClick={() => void toggleDisabled(!client.isDisabled)}
                    >
                      {busyKey === "status" ? (
                        <Spinner />
                      ) : (
                        <Icon name={client.isDisabled ? "check" : "ban"} className="h-4 w-4" />
                      )}
                      {client.isDisabled ? t("common.enable") : t("common.disable")}
                    </button>
                  }
                />
              ) : null}
            </dl>
            {client.notes ? (
              <div className="mx-5 mb-5 rounded-xl border border-surface-line bg-surface/50 p-3 text-xs leading-relaxed text-ink-muted">
                {client.notes}
              </div>
            ) : null}
          </section>

          <section className="card p-5">
            <h2 className="section-title">{t("clients.enforcement")}</h2>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <span className="text-ink-muted">{t("clients.expiryEnforcement")}</span>
                <span className="badge-ok">{t("clients.panelEnforced")}</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-ink-muted">{t("clients.trafficQuota")}</span>
                <span className="badge-warn">{t("clients.quotaUnavailable")}</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-ink-muted">{t("clients.maxConnections")}</span>
                <span className="badge-warn">{t("clients.connectionsUnavailable")}</span>
              </div>
            </div>
            <p className="mt-3 border-t border-surface-line pt-3 text-[11px] leading-relaxed text-ink-faint">
              {t("overview.limitTruth")}
            </p>
          </section>
        </div>

        <div className="space-y-5">
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="section-title">{t("clients.assignedConfigs")}</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  {t("clients.assignedProtocols")}: {client.protocolIds?.length ?? 0}
                </p>
              </div>
              <span className="badge-neutral">{activeAssignments.length}</span>
            </div>
            {activeAssignments.length === 0 ? (
              <EmptyState
                title={t("clients.noAssignments")}
                icon="configs"
                action={
                  canOperate ? (
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => {
                        setAssignConfigId(assignable[0]?.id ?? "");
                        setAssignOpen(true);
                      }}
                      disabled={assignable.length === 0}
                    >
                      <Icon name="plus" className="h-4 w-4" />
                      {t("clients.assign")}
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="divide-y divide-surface-line/70">
                {activeAssignments.map((assignment) => (
                  <div key={assignment.credentialId} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-overlay text-accent">
                          <Icon name="key" className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-medium text-ink">
                            {assignment.configurationName}
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-faint">
                            {assignment.protocolName} · {assignment.kind} ·{" "}
                            {formatDate(assignment.createdAt)}
                          </p>
                          {Object.keys(assignment.displayData).length > 0 ? (
                            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                              {Object.entries(assignment.displayData).map(([key, value]) => (
                                <div key={key} className="flex gap-1">
                                  <dt className="text-ink-faint">{key}:</dt>
                                  <dd className="font-mono text-ink-muted" dir="ltr">
                                    {String(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <p className="mt-1 text-[11px] text-ink-faint">
                              {t("clients.noPublicData")}
                            </p>
                          )}
                        </div>
                      </div>
                      {canOperate ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => void viewUri(assignment)}
                          >
                            <Icon name="eye" className="h-4 w-4" />
                            {t("clients.viewUri")}
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => void viewQr(assignment)}
                            title={t("clients.qr")}
                            aria-label={t("clients.qr")}
                          >
                            <Icon name="qr" className="h-4 w-4" />
                            QR
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            disabled={busyKey === `export:${assignment.credentialId}`}
                            onClick={() => void exportArtifact(assignment)}
                          >
                            {busyKey === `export:${assignment.credentialId}` ? (
                              <Spinner />
                            ) : (
                              <Icon name="download" className="h-4 w-4" />
                            )}
                            {t("clients.export")}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("clients.rotate")}
                            onClick={() => setConfirm({ kind: "rotate", assignment })}
                          >
                            <Icon name="refresh" className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="icon-btn text-warn"
                            title={t("clients.unassign")}
                            onClick={() => setConfirm({ kind: "unassign", assignment })}
                          >
                            <Icon name="ban" className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-header">
              <h2 className="section-title">{t("clients.subscriptionList")}</h2>
              {canOperate ? (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => setSubOpen(true)}
                >
                  <Icon name="plus" className="h-4 w-4" />
                  {t("subs.new")}
                </button>
              ) : null}
            </div>
            {subscriptions.length === 0 ? (
              <EmptyState title={t("clients.noSubscriptions")} icon="subscriptions" />
            ) : (
              <div className="divide-y divide-surface-line/70">
                {subscriptions.map((subscription) => (
                  <div
                    key={subscription.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-ink">{subscription.name}</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {t(`subs.format.${subscription.format}`)} · {subscription.tokenHint}… ·{" "}
                        {formatDate(subscription.lastAccessAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {subscription.revokedAt ? (
                        <span className="badge-danger">{t("subs.revokedAt")}</span>
                      ) : (
                        <span className="badge-ok">{t("common.active")}</span>
                      )}
                      <Link to="/subscriptions" className="btn-ghost btn-sm">
                        {t("common.details")}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="border-t border-surface-line px-5 py-3 text-[11px] text-ink-faint">
              {t("subs.urlNeverLogged")}
            </p>
          </section>

          {historyAssignments.length > 0 ? (
            <section className="card">
              <div className="card-header">
                <h2 className="section-title">{t("clients.credentialHistory")}</h2>
                <span className="badge-neutral">{historyAssignments.length}</span>
              </div>
              <div className="divide-y divide-surface-line/70">
                {historyAssignments.map((assignment) => (
                  <div
                    key={assignment.credentialId}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <p className="text-sm text-ink-muted">{assignment.configurationName}</p>
                      <p className="text-[11px] text-ink-faint">
                        {assignment.protocolName} · {t("clients.credentialCreated")}{" "}
                        {formatDate(assignment.createdAt)}
                      </p>
                    </div>
                    <span className="badge-warn">{formatDate(assignment.revokedAt, false)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <ClientFormModal
        open={editOpen}
        client={client}
        onClose={() => setEditOpen(false)}
        onSaved={() => void load()}
      />

      <SubscriptionFormModal
        open={subOpen}
        clients={[client]}
        fixedClientId={client.id}
        onClose={() => setSubOpen(false)}
        onCreated={() => void load()}
      />

      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={t("clients.assignTitle")}
        description={t("clients.assignHint")}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAssignOpen(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void assign()}
              disabled={assignBusy || !assignConfigId}
            >
              {assignBusy ? <Spinner /> : <Icon name="key" className="h-4 w-4" />}
              {t("clients.assign")}
            </button>
          </>
        }
      >
        {assignable.length === 0 ? (
          <Alert tone="warn">{t("clients.noAssignments")}</Alert>
        ) : (
          <Field label={t("clients.selectConfiguration")} htmlFor="assign-config" required>
            <select
              id="assign-config"
              className="select"
              value={assignConfigId}
              onChange={(event) => setAssignConfigId(event.target.value)}
            >
              {assignable.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.protocolName} · {config.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Modal>

      <Modal
        open={uriModal.open}
        onClose={() => setUriModal((current) => ({ ...current, open: false }))}
        title={`${t("clients.uriTitle")} · ${uriModal.title}`}
        size="lg"
        footer={
          <>
            {uriModal.uri ? <CopyButton value={uriModal.uri} /> : null}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setUriModal((current) => ({ ...current, open: false }))}
            >
              {t("common.close")}
            </button>
          </>
        }
      >
        {uriModal.loading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner className="h-6 w-6 text-accent" />
          </div>
        ) : uriModal.uri ? (
          <div className="space-y-3">
            <div className="code-block select-all" dir="ltr">
              {uriModal.uri}
            </div>
            <Alert tone="warn">{t("subs.publicNote")}</Alert>
          </div>
        ) : (
          <div className="space-y-3">
            <Alert tone="info">{t("clients.uriUnavailable")}</Alert>
            <pre className="code-block" dir="ltr">
              {uriModal.content}
            </pre>
          </div>
        )}
      </Modal>

      <Modal
        open={qrModal.open}
        onClose={() => setQrModal((current) => ({ ...current, open: false }))}
        title={`${t("clients.qrTitle")} · ${qrModal.title}`}
        size="sm"
        footer={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setQrModal((current) => ({ ...current, open: false }))}
          >
            {t("common.close")}
          </button>
        }
      >
        {qrModal.loading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner className="h-6 w-6 text-accent" />
          </div>
        ) : qrModal.error ? (
          <Alert tone="warn">{qrModal.error}</Alert>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <img
              src={qrModal.objectUrl}
              alt={qrModal.title}
              className="h-auto w-full max-w-[320px] rounded-xl border border-surface-line bg-white p-3"
            />
            <p className="text-xs text-ink-muted">{t("clients.qrScan")}</p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "deleteClient"
            ? t("common.delete")
            : confirm?.kind === "revokeClient"
              ? t("clients.revoke")
              : confirm?.kind === "rotate"
                ? t("clients.rotate")
                : confirm?.kind === "unassign"
                  ? t("clients.unassign")
                  : t("clients.revokeCredential")
        }
        message={
          confirm?.kind === "deleteClient"
            ? t("clients.deleteConfirm")
            : confirm?.kind === "revokeClient"
              ? t("clients.revokedConfirm")
              : confirm?.kind === "rotate"
                ? t("clients.rotateConfirm")
                : confirm?.kind === "unassign"
                  ? t("clients.unassignConfirm")
                  : t("clients.revokeCredentialConfirm")
        }
        loading={confirmBusy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
