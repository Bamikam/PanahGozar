import { useEffect, useState } from "react";
import type { ClientDTO } from "../../shared/types.js";
import { api, apiErrorMessage, errorDetails } from "../api.js";
import { useI18n } from "../i18n.js";
import { Alert, Field, Modal, Spinner, Toggle } from "./ui.js";
import { useToast } from "../toast.js";
import { isoFromLocalInput, localInputFromIso, splitTags } from "../lib/format.js";

interface ClientFormState {
  label: string;
  email: string;
  notes: string;
  tags: string;
  expiresAt: string;
  trafficQuotaBytes: string;
  maxConnections: string;
  isDisabled: boolean;
}

function emptyState(): ClientFormState {
  return {
    label: "",
    email: "",
    notes: "",
    tags: "",
    expiresAt: "",
    trafficQuotaBytes: "",
    maxConnections: "",
    isDisabled: false,
  };
}

function fromClient(client: ClientDTO): ClientFormState {
  return {
    label: client.label,
    email: client.email ?? "",
    notes: client.notes ?? "",
    tags: client.tags.join(", "),
    expiresAt: localInputFromIso(client.expiresAt),
    trafficQuotaBytes: client.trafficQuotaBytes ?? "",
    maxConnections: client.maxConnections !== null ? String(client.maxConnections) : "",
    isDisabled: client.isDisabled,
  };
}

export function ClientFormModal({
  open,
  client,
  onClose,
  onSaved,
}: {
  open: boolean;
  client: ClientDTO | null;
  onClose: () => void;
  onSaved: (client: ClientDTO) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<ClientFormState>(emptyState);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(client ? fromClient(client) : emptyState());
    setError("");
  }, [open, client]);

  const set = <K extends keyof ClientFormState>(key: K, value: ClientFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setError("");
    if (!form.label.trim()) {
      setError(t("error.validation"));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        label: form.label.trim(),
        email: form.email.trim() || null,
        notes: form.notes || null,
        tags: splitTags(form.tags),
        expiresAt: form.expiresAt ? isoFromLocalInput(form.expiresAt) : null,
        trafficQuotaBytes: form.trafficQuotaBytes.trim() || null,
        maxConnections: form.maxConnections.trim() ? Number(form.maxConnections) : null,
        isDisabled: form.isDisabled,
      };
      const saved = client
        ? await api.patch<ClientDTO>(`/api/clients/${client.id}`, payload)
        : await api.post<ClientDTO>("/api/clients", payload);
      toast.success(client ? t("clients.updated") : t("clients.created"));
      onSaved(saved);
      onClose();
    } catch (err) {
      const details = errorDetails(err);
      setError(
        details.length > 0
          ? details
              .map((detail) => `${detail.path ? `${detail.path}: ` : ""}${detail.message}`)
              .join("\n")
          : apiErrorMessage(err, t("common.error"))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={client ? t("clients.edit") : t("clients.new")}
      size="lg"
      footer={
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
            {client ? t("common.save") : t("common.create")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("clients.label")} htmlFor="client-label" required>
            <input
              id="client-label"
              className="input"
              value={form.label}
              onChange={(event) => set("label", event.target.value)}
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field label={t("clients.email")} htmlFor="client-email">
            <input
              id="client-email"
              type="email"
              className="input"
              value={form.email}
              onChange={(event) => set("email", event.target.value)}
              maxLength={160}
              dir="ltr"
            />
          </Field>
        </div>
        <Field label={t("clients.tags")} htmlFor="client-tags" hint={t("clients.tagsHint")}>
          <input
            id="client-tags"
            className="input"
            value={form.tags}
            onChange={(event) => set("tags", event.target.value)}
          />
        </Field>
        <Field label={t("clients.notes")} htmlFor="client-notes">
          <textarea
            id="client-notes"
            className="textarea"
            value={form.notes}
            onChange={(event) => set("notes", event.target.value)}
            maxLength={4000}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t("clients.expiresAt")}
            htmlFor="client-expiry"
            hint={t("clients.expiresHint")}
          >
            <input
              id="client-expiry"
              type="datetime-local"
              className="input"
              value={form.expiresAt}
              onChange={(event) => set("expiresAt", event.target.value)}
            />
          </Field>
          <Field
            label={t("clients.trafficQuota")}
            htmlFor="client-quota"
            hint={t("clients.trafficQuotaHint")}
          >
            <input
              id="client-quota"
              inputMode="numeric"
              className="input"
              value={form.trafficQuotaBytes}
              onChange={(event) =>
                set("trafficQuotaBytes", event.target.value.replace(/[^\d]/g, ""))
              }
              placeholder="0"
              dir="ltr"
            />
          </Field>
        </div>
        <Field
          label={t("clients.maxConnections")}
          htmlFor="client-connections"
          hint={t("clients.maxConnectionsHint")}
        >
          <input
            id="client-connections"
            type="number"
            min={0}
            max={100000}
            className="input"
            value={form.maxConnections}
            onChange={(event) => set("maxConnections", event.target.value)}
            dir="ltr"
          />
        </Field>
        {client ? (
          <div className="flex items-center justify-between rounded-xl border border-surface-line bg-surface/50 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-ink">{t("clients.statusDisabled")}</p>
              <p className="text-[11px] text-ink-faint">{t("clients.disabledNotice")}</p>
            </div>
            <Toggle
              checked={form.isDisabled}
              onChange={(value) => set("isDisabled", value)}
              label={t("clients.statusDisabled")}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
