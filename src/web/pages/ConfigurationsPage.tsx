import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  ConfigurationDTO,
  ConfigurationVersionDTO,
  Paginated,
  ProtocolCatalogResponse,
} from "../../shared/types.js";
import { api, apiErrorMessage, errorDetails } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
} from "../components/ui.js";
import { ConfigurationFormModal } from "../components/ConfigurationForm.js";

type ImportSource = "import-xray" | "import-singbox";

export function ConfigurationsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { canOperate, isAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [configs, setConfigs] = useState<ConfigurationDTO[]>([]);
  const [catalog, setCatalog] = useState<ProtocolCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [protocolFilter, setProtocolFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConfigurationDTO | null>(null);
  const [protocolHint, setProtocolHint] = useState<string | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [versionsFor, setVersionsFor] = useState<ConfigurationDTO | null>(null);
  const [versions, setVersions] = useState<ConfigurationVersionDTO[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfigurationDTO | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importSource, setImportSource] = useState<ImportSource>("import-xray");
  const [importProtocol, setImportProtocol] = useState("vless");
  const [importText, setImportText] = useState("");
  const [importPublicHost, setImportPublicHost] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [configRows, protocolData] = await Promise.all([
        api.get<ConfigurationDTO[]>("/api/configurations"),
        api.get<ProtocolCatalogResponse>("/api/protocols"),
      ]);
      setConfigs(configRows);
      setCatalog(protocolData);
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

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditing(null);
      setProtocolHint(searchParams.get("protocol") ?? undefined);
      setFormOpen(true);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return configs.filter((config) => {
      if (protocolFilter && config.protocolId !== protocolFilter) return false;
      if (!needle) return true;
      return (
        config.name.toLowerCase().includes(needle) ||
        config.protocolName.toLowerCase().includes(needle) ||
        config.protocolId.toLowerCase().includes(needle)
      );
    });
  }, [configs, search, protocolFilter]);

  const openCreate = (protocolId?: string) => {
    setEditing(null);
    setProtocolHint(protocolId);
    setFormOpen(true);
  };

  const openEdit = (config: ConfigurationDTO) => {
    setEditing(config);
    setProtocolHint(undefined);
    setFormOpen(true);
  };

  const toggleActive = async (config: ConfigurationDTO) => {
    setBusyKey(`toggle:${config.id}`);
    try {
      await api.patch(`/api/configurations/${config.id}`, { isActive: !config.isActive });
      toast.success(t("configs.toggled"));
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const downloadServer = async (config: ConfigurationDTO) => {
    setBusyKey(`export:${config.id}`);
    try {
      await api.download(
        `/api/configurations/${config.id}/export/server`,
        `${config.protocolId}-server.json`
      );
      toast.success(t("configs.exported"));
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const downloadAllXray = async () => {
    setBusyKey("export:all");
    try {
      await api.download("/api/export/xray-skeleton", "xray-server-config.json");
      toast.success(t("configs.exported"));
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const loadVersions = async (config: ConfigurationDTO) => {
    setVersionsFor(config);
    setVersions([]);
    setVersionsLoading(true);
    try {
      const result = await api.get<Paginated<ConfigurationVersionDTO>>(
        `/api/configurations/${config.id}/versions?page=1&pageSize=100`
      );
      setVersions(result.items);
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setVersionsLoading(false);
    }
  };

  const rollback = async () => {
    if (!versionsFor || rollbackTarget === null) return;
    setBusyKey("rollback");
    try {
      await api.post(`/api/configurations/${versionsFor.id}/rollback`, {
        versionNumber: rollbackTarget,
      });
      toast.success(t("configs.rolledBack"));
      setRollbackTarget(null);
      await loadVersions(versionsFor);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusyKey("delete");
    try {
      await api.del(`/api/configurations/${confirmDelete.id}`);
      toast.success(t("configs.deleted"));
      setConfirmDelete(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusyKey("");
    }
  };

  const submitImport = async () => {
    setImportError("");
    if (!importText.trim()) {
      setImportError(t("error.validation"));
      return;
    }
    setImportBusy(true);
    try {
      await api.post(
        `/api/configurations/import/${importSource === "import-xray" ? "xray" : "singbox"}`,
        {
          protocolId: importProtocol,
          text: importText,
          publicHost: importPublicHost.trim() || undefined,
        }
      );
      toast.success(t("configs.imported"));
      setImportOpen(false);
      setImportText("");
      setImportPublicHost("");
      await load();
    } catch (err) {
      const details = errorDetails(err);
      setImportError(
        details.length > 0
          ? details
              .map((detail) => `${detail.path ? `${detail.path}: ` : ""}${detail.message}`)
              .join("\n")
          : apiErrorMessage(err, t("configs.importFailed"))
      );
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("configs.title")}
        subtitle={t("configs.subtitle")}
        actions={
          canOperate ? (
            <>
              <button type="button" className="btn-secondary" onClick={() => setImportOpen(true)}>
                <Icon name="download" className="h-4 w-4" />
                {t("configs.import")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void downloadAllXray()}
                disabled={busyKey === "export:all"}
              >
                {busyKey === "export:all" ? <Spinner /> : <Icon name="file" className="h-4 w-4" />}
                {t("configs.exportXray")}
              </button>
              <button type="button" className="btn-primary" onClick={() => openCreate()}>
                <Icon name="plus" className="h-4 w-4" />
                {t("configs.new")}
              </button>
            </>
          ) : null
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Icon
            name="search"
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          />
          <input
            className="input ps-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("configs.search")}
          />
        </div>
        <select
          className="select sm:w-56"
          value={protocolFilter}
          onChange={(event) => setProtocolFilter(event.target.value)}
          aria-label={t("configs.protocol")}
        >
          <option value="">{t("configs.filterProtocol")}</option>
          {catalog?.protocols.map((protocol) => (
            <option key={protocol.id} value={protocol.id}>
              {protocol.displayName}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t("configs.empty")}
            icon="configs"
            action={
              canOperate ? (
                <button type="button" className="btn-primary btn-sm" onClick={() => openCreate()}>
                  <Icon name="plus" className="h-4 w-4" />
                  {t("configs.new")}
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
                <th>{t("configs.name")}</th>
                <th>{t("configs.protocol")}</th>
                <th>{t("common.status")}</th>
                <th>{t("configs.version")}</th>
                <th>{t("common.updated")}</th>
                <th className="text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((config) => (
                <tr key={config.id}>
                  <td>
                    <p className="font-medium text-ink">{config.name}</p>
                    {config.notes ? (
                      <p className="mt-0.5 max-w-xs truncate text-[11px] text-ink-faint">
                        {config.notes}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge-neutral">{config.protocolName}</span>
                  </td>
                  <td>
                    {config.isActive ? (
                      <span className="badge-ok">{t("configs.active")}</span>
                    ) : (
                      <span className="badge-warn">{t("configs.inactive")}</span>
                    )}
                  </td>
                  <td className="font-mono text-xs text-ink-muted" dir="ltr">
                    v{formatNumber(config.currentVersion)}
                  </td>
                  <td className="whitespace-nowrap text-xs text-ink-muted">
                    {formatDate(config.updatedAt)}
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => void loadVersions(config)}
                        title={t("configs.loadVersions")}
                        aria-label={t("configs.loadVersions")}
                      >
                        <Icon name="clock" className="h-4 w-4" />
                      </button>
                      {canOperate ? (
                        <>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => openEdit(config)}
                            title={t("common.edit")}
                            aria-label={t("common.edit")}
                          >
                            <Icon name="edit" className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void toggleActive(config)}
                            disabled={busyKey === `toggle:${config.id}`}
                            title={config.isActive ? t("common.disable") : t("common.enable")}
                            aria-label={config.isActive ? t("common.disable") : t("common.enable")}
                          >
                            {busyKey === `toggle:${config.id}` ? (
                              <Spinner />
                            ) : (
                              <Icon name={config.isActive ? "ban" : "check"} className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void downloadServer(config)}
                            disabled={busyKey === `export:${config.id}`}
                            title={t("configs.exportServer")}
                            aria-label={t("configs.exportServer")}
                          >
                            {busyKey === `export:${config.id}` ? (
                              <Spinner />
                            ) : (
                              <Icon name="download" className="h-4 w-4" />
                            )}
                          </button>
                          {isAdmin ? (
                            <button
                              type="button"
                              className="icon-btn text-danger"
                              onClick={() => setConfirmDelete(config)}
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
        </div>
      )}

      {canOperate ? (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          {t("configs.serverSecurity")}
        </p>
      ) : null}

      <ConfigurationFormModal
        open={formOpen}
        configuration={editing}
        protocolHint={protocolHint}
        onClose={() => setFormOpen(false)}
        onSaved={() => void load()}
      />

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t("configs.importTitle")}
        description={t("configs.importHelp")}
        size="xl"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setImportOpen(false)}
              disabled={importBusy}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submitImport()}
              disabled={importBusy}
            >
              {importBusy ? <Spinner /> : <Icon name="download" className="h-4 w-4" />}
              {t("configs.import")}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {importError ? (
            <Alert tone="danger">
              <pre className="whitespace-pre-wrap font-sans">{importError}</pre>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("configs.importSource")} htmlFor="import-source">
              <select
                id="import-source"
                className="select"
                value={importSource}
                onChange={(event) => setImportSource(event.target.value as ImportSource)}
              >
                <option value="import-xray">{t("configs.importXray")}</option>
                <option value="import-singbox">{t("configs.importSingbox")}</option>
              </select>
            </Field>
            <Field label={t("configs.protocol")} htmlFor="import-protocol">
              <select
                id="import-protocol"
                className="select"
                value={importProtocol}
                onChange={(event) => setImportProtocol(event.target.value)}
              >
                {["vless", "vmess", "trojan", "shadowsocks", "socks", "http"].map((id) => (
                  <option key={id} value={id}>
                    {catalog?.protocols.find((p) => p.id === id)?.displayName ?? id}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label={t("configs.importPublicHost")}
            htmlFor="import-host"
            hint={t("configs.importPublicHostHint")}
          >
            <input
              id="import-host"
              className="input"
              value={importPublicHost}
              onChange={(event) => setImportPublicHost(event.target.value)}
              placeholder="vpn.example.com"
              dir="ltr"
            />
          </Field>
          <Field label={t("configs.importText")} htmlFor="import-text">
            <textarea
              id="import-text"
              className="textarea min-h-[280px] font-mono text-xs"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              dir="ltr"
              spellCheck={false}
              placeholder={
                importSource === "import-xray" ? '{"inbounds":[...]}' : '{"outbounds":[...]}'
              }
            />
          </Field>
          <Alert tone="warn">{t("configs.importHelp")}</Alert>
        </div>
      </Modal>

      <Modal
        open={versionsFor !== null}
        onClose={() => setVersionsFor(null)}
        title={`${t("configs.versionsTitle")} · ${versionsFor?.name ?? ""}`}
        description={t("configs.versionsHint")}
        size="xl"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setVersionsFor(null)}>
            {t("common.close")}
          </button>
        }
      >
        {versionsLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner className="h-6 w-6 text-accent" />
          </div>
        ) : versions.length === 0 ? (
          <EmptyState title={t("configs.noVersions")} icon="clock" />
        ) : (
          <ul className="space-y-3">
            {versions.map((version) => (
              <li
                key={version.id}
                className="rounded-xl border border-surface-line bg-surface/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {t("configs.versionNumber", { version: version.versionNumber })}
                      <span className="ms-2 badge-neutral">{version.source}</span>
                    </p>
                    <p className="mt-1 text-[11px] text-ink-faint">
                      {formatDate(version.createdAt)} · {version.createdBy ?? "system"}
                      {version.changeNote ? ` · ${version.changeNote}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <CopyButton
                      value={JSON.stringify(version.config, null, 2)}
                      label={t("common.copy")}
                    />
                    {canOperate ? (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => setRollbackTarget(version.versionNumber)}
                      >
                        <Icon name="refresh" className="h-4 w-4" />
                        {t("configs.rollback")}
                      </button>
                    ) : null}
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-ink-muted">
                    {t("common.details")}
                  </summary>
                  <pre className="code-block mt-2 max-h-48 text-[10px]" dir="ltr">
                    {JSON.stringify(version.config, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("common.delete")}
        message={t("configs.deleteConfirm")}
        loading={busyKey === "delete"}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={rollbackTarget !== null}
        title={t("configs.rollback")}
        message={t("configs.rollbackConfirm", { version: rollbackTarget ?? "" })}
        confirmLabel={t("configs.rollback")}
        loading={busyKey === "rollback"}
        danger={false}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={() => void rollback()}
      />
    </div>
  );
}
