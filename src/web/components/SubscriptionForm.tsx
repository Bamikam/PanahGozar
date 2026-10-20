import { useEffect, useState } from "react";
import type { ClientDTO, SubscriptionFormat } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { Alert, CopyButton, Field, Modal, Spinner } from "./ui.js";
import { useToast } from "../toast.js";
import { isoFromLocalInput } from "../lib/format.js";

interface CreatedSubscription {
  id: string;
  url: string;
  tokenHint: string;
  format: SubscriptionFormat;
  expiresAt: string | null;
}

export function SubscriptionFormModal({
  open,
  clients,
  fixedClientId,
  defaultFormat = "xray_uri",
  onClose,
  onCreated,
}: {
  open: boolean;
  clients: ClientDTO[];
  fixedClientId?: string;
  defaultFormat?: SubscriptionFormat;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [clientId, setClientId] = useState(fixedClientId ?? clients[0]?.id ?? "");
  const [name, setName] = useState("");
  const [format, setFormat] = useState<SubscriptionFormat>(defaultFormat);
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedSubscription | null>(null);

  useEffect(() => {
    if (!open) return;
    setClientId(fixedClientId ?? clients[0]?.id ?? "");
    setName("");
    setFormat(defaultFormat);
    setExpiresAt("");
    setError("");
    setCreated(null);
  }, [open, fixedClientId, clients, defaultFormat]);

  const submit = async () => {
    setError("");
    if (!clientId || !name.trim()) {
      setError(t("error.validation"));
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<CreatedSubscription>("/api/subscriptions", {
        clientId,
        name: name.trim(),
        format,
        expiresAt: expiresAt ? isoFromLocalInput(expiresAt) : null,
      });
      setCreated(result);
      toast.success(t("subs.created"));
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={created ? t("subs.urlOnce") : t("subs.new")}
      description={created ? t("subs.urlWarning") : t("subs.formatHint")}
      size="lg"
      footer={
        created ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            {t("common.close")}
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? <Spinner /> : null}
              {t("common.create")}
            </button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-4">
          <Alert tone="warn" title={t("subs.urlWarning")}>
            {t("subs.publicNote")}
          </Alert>
          <div className="code-block select-all" dir="ltr">
            {created.url}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={created.url} />
            <a href={created.url} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
              {t("common.view")}
            </a>
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-surface-line bg-surface/40 px-3 py-2">
              <dt className="text-ink-faint">{t("subs.format")}</dt>
              <dd className="mt-0.5 text-ink">{t(`subs.format.${created.format}`)}</dd>
            </div>
            <div className="rounded-lg border border-surface-line bg-surface/40 px-3 py-2">
              <dt className="text-ink-faint">{t("subs.tokenHint")}</dt>
              <dd className="mt-0.5 font-mono text-ink" dir="ltr">
                {created.tokenHint}…
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!fixedClientId ? (
            <Field label={t("subs.client")} htmlFor="sub-client" required>
              <select
                id="sub-client"
                className="select"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              >
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.label}
                    {client.email ? ` · ${client.email}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label={t("subs.name")} htmlFor="sub-name" required>
            <input
              id="sub-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoFocus
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("subs.format")} htmlFor="sub-format">
              <select
                id="sub-format"
                className="select"
                value={format}
                onChange={(event) => setFormat(event.target.value as SubscriptionFormat)}
              >
                <option value="xray_uri">{t("subs.format.xray_uri")}</option>
                <option value="raw_uri">{t("subs.format.raw_uri")}</option>
                <option value="singbox_json">{t("subs.format.singbox_json")}</option>
              </select>
            </Field>
            <Field label={t("subs.expiresAt")} htmlFor="sub-expiry">
              <input
                id="sub-expiry"
                type="datetime-local"
                className="input"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">{t("subs.noCompatible")}</p>
        </div>
      )}
    </Modal>
  );
}
