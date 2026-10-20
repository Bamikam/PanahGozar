import { useEffect, useMemo, useState } from "react";
import type { ConfigurationDTO } from "../../shared/types.js";
import { api, apiErrorMessage, errorDetails } from "../api.js";
import { useI18n } from "../i18n.js";
import { Alert, CopyButton, Field, Modal, Spinner, Toggle } from "./ui.js";
import { useToast } from "../toast.js";

type ProtocolId =
  | "vless"
  | "vmess"
  | "trojan"
  | "shadowsocks"
  | "socks"
  | "http"
  | "mtproto"
  | "wireguard"
  | "openvpn";

const PROTOCOLS: { id: ProtocolId; label: string }[] = [
  { id: "vless", label: "VLESS" },
  { id: "vmess", label: "VMess" },
  { id: "trojan", label: "Trojan" },
  { id: "shadowsocks", label: "Shadowsocks" },
  { id: "socks", label: "SOCKS5" },
  { id: "http", label: "HTTP / HTTPS" },
  { id: "mtproto", label: "Telegram MTProto" },
  { id: "wireguard", label: "WireGuard" },
  { id: "openvpn", label: "OpenVPN" },
];

const PROTOCOL_IDS = new Set(PROTOCOLS.map((item) => item.id));

function defaults(protocolId: ProtocolId): Record<string, unknown> {
  switch (protocolId) {
    case "vless":
      return {
        host: "",
        port: 443,
        transport: { network: "ws", security: "tls", path: "/", tlsAllowInsecure: false },
        allowTransparent: false,
      };
    case "vmess":
      return {
        host: "",
        port: 443,
        transport: { network: "ws", security: "tls", path: "/", tlsAllowInsecure: false },
        usersAlterId: 0,
        cipher: "auto",
      };
    case "trojan":
      return { host: "", port: 443 };
    case "shadowsocks":
      return { host: "", port: 8388, method: "aes-256-gcm", network: "tcp", uotUdp: false };
    case "socks":
      return { host: "", port: 1080, bindAddress: "0.0.0.0", udpAssociate: false };
    case "http":
      return {
        host: "",
        port: 8080,
        bindAddress: "0.0.0.0",
        allowConnect: true,
        connectDomains: [],
        timeoutSeconds: 300,
        tls: false,
      };
    case "mtproto":
      return { host: "", port: 443, preferredTransport: "port" };
    case "wireguard":
      return {
        serverPort: 51820,
        listenAddressCidr: "10.8.0.1/24",
        serverEndpointHost: "",
        serverEndpointPort: 51820,
        allowedIps: "0.0.0.0/0, ::/0",
        clientDnsServers: ["1.1.1.1"],
        keepaliveSeconds: 25,
      };
    case "openvpn":
      return { label: "", profileText: "" };
  }
}

const OPTIONAL_STRING_KEYS = new Set([
  "tlsSni",
  "fallbackTarget",
  "path",
  "host",
  "serviceName",
  "adTag",
  "certificateFile",
  "keyFile",
]);

function cleanConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanConfig);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      if (OPTIONAL_STRING_KEYS.has(key) && item === "") continue;
      out[key] = cleanConfig(item);
    }
    return out;
  }
  return value;
}

function num(value: string): number {
  return Number(value);
}

function transport(config: Record<string, unknown>): Record<string, unknown> {
  return (config.transport as Record<string, unknown> | undefined) ?? {};
}

export function ConfigurationFormModal({
  open,
  protocolHint,
  configuration,
  onClose,
  onSaved,
}: {
  open: boolean;
  protocolHint?: string;
  configuration: ConfigurationDTO | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [protocolId, setProtocolId] = useState<ProtocolId>(
    configuration && PROTOCOL_IDS.has(configuration.protocolId as ProtocolId)
      ? (configuration.protocolId as ProtocolId)
      : protocolHint && PROTOCOL_IDS.has(protocolHint as ProtocolId)
        ? (protocolHint as ProtocolId)
        : "vless"
  );
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [config, setConfig] = useState<Record<string, unknown>>(defaults("vless"));
  const [jsonText, setJsonText] = useState("");
  const [tab, setTab] = useState<"form" | "json">("form");
  const [jsonError, setJsonError] = useState("");
  const [validation, setValidation] = useState<{
    valid: boolean;
    issues: { path: string; message: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const resolvedProtocol: ProtocolId =
      configuration && PROTOCOL_IDS.has(configuration.protocolId as ProtocolId)
        ? (configuration.protocolId as ProtocolId)
        : protocolHint && PROTOCOL_IDS.has(protocolHint as ProtocolId)
          ? (protocolHint as ProtocolId)
          : "vless";
    setProtocolId(resolvedProtocol);
    setName(configuration?.name ?? "");
    setNotes(configuration?.notes ?? "");
    setActive(configuration?.isActive ?? true);
    const initial = configuration?.config ?? defaults(resolvedProtocol);
    setConfig(initial);
    setJsonText(JSON.stringify(initial, null, 2));
    setTab("form");
    setJsonError("");
    setValidation(null);
    setError("");
  }, [open, configuration, protocolHint]);

  const set = (key: string, value: unknown) =>
    setConfig((current) => ({ ...current, [key]: value }));
  const setTransport = (key: string, value: unknown) =>
    setConfig((current) => ({
      ...current,
      transport: { ...transport(current), [key]: value },
    }));

  const switchProtocol = (next: ProtocolId) => {
    setProtocolId(next);
    const initial = defaults(next);
    setConfig(initial);
    setJsonText(JSON.stringify(initial, null, 2));
    setValidation(null);
    setJsonError("");
  };

  const applyJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError(t("configs.invalidJson"));
        return;
      }
      setConfig(parsed as Record<string, unknown>);
      setJsonError("");
      setValidation(null);
    } catch {
      setJsonError(t("configs.invalidJson"));
    }
  };

  const currentConfig = (): Record<string, unknown> | null => {
    if (tab === "json") {
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonError(t("configs.invalidJson"));
          return null;
        }
        return cleanConfig(parsed) as Record<string, unknown>;
      } catch {
        setJsonError(t("configs.invalidJson"));
        return null;
      }
    }
    return cleanConfig(config) as Record<string, unknown>;
  };

  const validate = async () => {
    const candidate = currentConfig();
    if (!candidate) return;
    setValidating(true);
    setValidation(null);
    try {
      const result = await api.post<{
        valid: boolean;
        issues: { path: string; message: string }[];
      }>("/api/configurations/validate", { protocolId, config: candidate });
      setValidation(result);
    } catch (err) {
      const error = err as { details?: unknown; message?: string };
      setValidation({
        valid: false,
        issues: Array.isArray(error.details)
          ? (error.details as { path: string; message: string }[])
          : [{ path: "(root)", message: apiErrorMessage(err, t("common.error")) }],
      });
    } finally {
      setValidating(false);
    }
  };

  const submit = async () => {
    const candidate = currentConfig();
    if (!candidate) return;
    setError("");
    if (!name.trim()) {
      setError(t("error.validation"));
      return;
    }
    setBusy(true);
    try {
      if (configuration) {
        await api.patch(`/api/configurations/${configuration.id}`, {
          name: name.trim(),
          notes: notes || null,
          isActive: active,
          config: candidate,
        });
        toast.success(t("configs.updated"));
      } else {
        await api.post("/api/configurations", {
          protocolId,
          name: name.trim(),
          notes: notes || null,
          isActive: active,
          config: candidate,
        });
        toast.success(t("configs.created"));
      }
      onSaved();
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

  const configPreview = useMemo(() => {
    try {
      return JSON.stringify(tab === "json" ? JSON.parse(jsonText) : config, null, 2);
    } catch {
      return jsonText;
    }
  }, [tab, jsonText, config]);

  const tr = transport(config);
  const optional = (key: string) => (config[key] as string | undefined) ?? "";
  const setOptional = (key: string, value: string) => {
    if (!value) {
      setConfig((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } else {
      set(key, value);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={configuration ? t("configs.edit") : t("configs.new")}
      size="2xl"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void validate()}
            disabled={validating}
          >
            {validating ? <Spinner /> : <IconCheck />}
            {t("configs.validate")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy || Boolean(jsonError)}
          >
            {busy ? <Spinner /> : null}
            {configuration ? t("common.save") : t("common.create")}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {error ? (
          <Alert tone="danger">
            <pre className="whitespace-pre-wrap font-sans">{error}</pre>
          </Alert>
        ) : null}
        {validation ? (
          validation.valid ? (
            <Alert tone="ok">{t("configs.validationPassed")}</Alert>
          ) : (
            <Alert tone="danger" title={t("configs.validationFailed")}>
              <ul className="list-inside list-disc space-y-1">
                {validation.issues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`}>
                    <span className="font-mono text-xs">{issue.path || "(root)"}</span>:{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("configs.protocol")} htmlFor="config-protocol" required>
            <select
              id="config-protocol"
              className="select"
              value={protocolId}
              onChange={(event) => switchProtocol(event.target.value as ProtocolId)}
              disabled={Boolean(configuration)}
            >
              {PROTOCOLS.map((protocol) => (
                <option key={protocol.id} value={protocol.id}>
                  {protocol.label}
                </option>
              ))}
            </select>
            {configuration ? <p className="field-hint">{t("configs.protocolLocked")}</p> : null}
          </Field>
          <Field label={t("configs.name")} htmlFor="config-name" required>
            <input
              id="config-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-surface-line bg-surface p-1">
            <button
              type="button"
              className={`tab-button ${tab === "form" ? "tab-button-active" : ""}`}
              onClick={() => setTab("form")}
            >
              {t("configs.form")}
            </button>
            <button
              type="button"
              className={`tab-button ${tab === "json" ? "tab-button-active" : ""}`}
              onClick={() => {
                setJsonText(JSON.stringify(config, null, 2));
                setTab("json");
              }}
            >
              {t("configs.json")}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <Toggle checked={active} onChange={setActive} label={t("configs.active")} />
            {t("configs.active")}
          </label>
        </div>

        {tab === "json" ? (
          <Field
            label={t("configs.advancedJson")}
            htmlFor="config-json"
            hint={t("configs.jsonHint")}
            error={jsonError || undefined}
          >
            <textarea
              id="config-json"
              className={`textarea min-h-[360px] font-mono text-xs ${jsonError ? "input-error" : ""}`}
              value={jsonText}
              onChange={(event) => applyJson(event.target.value)}
              dir="ltr"
              spellCheck={false}
            />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {protocolId !== "openvpn" && protocolId !== "wireguard" ? (
              <>
                <Field
                  label={t("field.host")}
                  htmlFor="cfg-host"
                  hint={t("field.hostHint")}
                  required
                >
                  <input
                    id="cfg-host"
                    className="input"
                    value={(config.host as string) ?? ""}
                    onChange={(event) => set("host", event.target.value)}
                    placeholder="vpn.example.com"
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.port")} htmlFor="cfg-port" required>
                  <input
                    id="cfg-port"
                    type="number"
                    min={1}
                    max={65535}
                    className="input"
                    value={String(config.port ?? "")}
                    onChange={(event) => set("port", num(event.target.value))}
                    dir="ltr"
                  />
                </Field>
              </>
            ) : null}

            {protocolId === "vless" || protocolId === "vmess" ? (
              <>
                <Field label={t("field.network")} htmlFor="cfg-network">
                  <select
                    id="cfg-network"
                    className="select"
                    value={(tr.network as string) ?? "tcp"}
                    onChange={(event) => setTransport("network", event.target.value)}
                  >
                    <option value="tcp">TCP</option>
                    <option value="ws">WebSocket</option>
                    <option value="grpc">gRPC</option>
                  </select>
                </Field>
                <Field label={t("field.security")} htmlFor="cfg-security">
                  <select
                    id="cfg-security"
                    className="select"
                    value={(tr.security as string) ?? "none"}
                    onChange={(event) => setTransport("security", event.target.value)}
                  >
                    <option value="none">{t("common.none")}</option>
                    <option value="tls">TLS</option>
                  </select>
                </Field>
                {tr.network === "ws" ? (
                  <>
                    <Field label={t("field.path")} htmlFor="cfg-path">
                      <input
                        id="cfg-path"
                        className="input"
                        value={(tr.path as string) ?? "/"}
                        onChange={(event) => setTransport("path", event.target.value)}
                        dir="ltr"
                      />
                    </Field>
                    <Field label={t("field.wsHost")} htmlFor="cfg-ws-host">
                      <input
                        id="cfg-ws-host"
                        className="input"
                        value={(tr.host as string) ?? ""}
                        onChange={(event) => setTransport("host", event.target.value)}
                        dir="ltr"
                      />
                    </Field>
                  </>
                ) : null}
                {tr.network === "grpc" ? (
                  <Field label={t("field.serviceName")} htmlFor="cfg-service">
                    <input
                      id="cfg-service"
                      className="input"
                      value={(tr.serviceName as string) ?? ""}
                      onChange={(event) => setTransport("serviceName", event.target.value)}
                      dir="ltr"
                    />
                  </Field>
                ) : null}
                {tr.security === "tls" ? (
                  <>
                    <Field label={t("field.tlsSni")} htmlFor="cfg-sni">
                      <input
                        id="cfg-sni"
                        className="input"
                        value={(tr.tlsSni as string) ?? ""}
                        onChange={(event) => setTransport("tlsSni", event.target.value)}
                        dir="ltr"
                      />
                    </Field>
                    <Field
                      label={t("field.certificateFile")}
                      htmlFor="cfg-cert"
                      hint={t("field.certificateHint")}
                    >
                      <input
                        id="cfg-cert"
                        className="input font-mono"
                        value={(tr.certificateFile as string) ?? ""}
                        onChange={(event) => setTransport("certificateFile", event.target.value)}
                        placeholder="/etc/xray/fullchain.pem"
                        dir="ltr"
                      />
                    </Field>
                    <Field label={t("field.keyFile")} htmlFor="cfg-key">
                      <input
                        id="cfg-key"
                        className="input font-mono"
                        value={(tr.keyFile as string) ?? ""}
                        onChange={(event) => setTransport("keyFile", event.target.value)}
                        placeholder="/etc/xray/privkey.pem"
                        dir="ltr"
                      />
                    </Field>
                  </>
                ) : null}
                {protocolId === "vmess" ? (
                  <>
                    <Field label={t("field.alterId")} htmlFor="cfg-aid">
                      <input
                        id="cfg-aid"
                        type="number"
                        min={0}
                        max={65535}
                        className="input"
                        value={String(config.usersAlterId ?? 0)}
                        onChange={(event) => set("usersAlterId", num(event.target.value))}
                        dir="ltr"
                      />
                    </Field>
                    <Field label={t("field.cipher")} htmlFor="cfg-cipher">
                      <select
                        id="cfg-cipher"
                        className="select"
                        value={(config.cipher as string) ?? "auto"}
                        onChange={(event) => set("cipher", event.target.value)}
                      >
                        <option value="auto">auto</option>
                        <option value="aes-128-gcm">aes-128-gcm</option>
                        <option value="chacha20-poly1305">chacha20-poly1305</option>
                        <option value="none">none</option>
                      </select>
                    </Field>
                  </>
                ) : null}
              </>
            ) : null}

            {protocolId === "trojan" ? (
              <>
                <Field label={t("field.tlsSni")} htmlFor="cfg-trojan-sni">
                  <input
                    id="cfg-trojan-sni"
                    className="input"
                    value={optional("tlsSni")}
                    onChange={(event) => setOptional("tlsSni", event.target.value)}
                    dir="ltr"
                  />
                </Field>
                <Field
                  label={t("field.fallback")}
                  htmlFor="cfg-fallback"
                  hint={t("field.fallbackHint")}
                >
                  <input
                    id="cfg-fallback"
                    className="input"
                    value={optional("fallbackTarget")}
                    onChange={(event) => setOptional("fallbackTarget", event.target.value)}
                    placeholder="example.com:80"
                    dir="ltr"
                  />
                </Field>
                <Field
                  label={t("field.certificateFile")}
                  htmlFor="cfg-trojan-cert"
                  hint={t("field.certificateHint")}
                >
                  <input
                    id="cfg-trojan-cert"
                    className="input font-mono"
                    value={optional("certificateFile")}
                    onChange={(event) => setOptional("certificateFile", event.target.value)}
                    placeholder="/etc/xray/fullchain.pem"
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.keyFile")} htmlFor="cfg-trojan-key">
                  <input
                    id="cfg-trojan-key"
                    className="input font-mono"
                    value={optional("keyFile")}
                    onChange={(event) => setOptional("keyFile", event.target.value)}
                    placeholder="/etc/xray/privkey.pem"
                    dir="ltr"
                  />
                </Field>
              </>
            ) : null}

            {protocolId === "shadowsocks" ? (
              <>
                <Field label={t("field.method")} htmlFor="cfg-method">
                  <select
                    id="cfg-method"
                    className="select"
                    value={(config.method as string) ?? "aes-256-gcm"}
                    onChange={(event) => set("method", event.target.value)}
                  >
                    {[
                      "aes-256-gcm",
                      "aes-128-gcm",
                      "chacha20-poly1305",
                      "chacha20-ietf-poly1305",
                      "xchacha20-poly1305",
                    ].map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("field.ssNetwork")} htmlFor="cfg-ss-network">
                  <select
                    id="cfg-ss-network"
                    className="select"
                    value={(config.network as string) ?? "tcp"}
                    onChange={(event) => set("network", event.target.value)}
                  >
                    <option value="tcp">TCP</option>
                    <option value="tcp,udp">TCP + UDP</option>
                  </select>
                </Field>
              </>
            ) : null}

            {protocolId === "socks" || protocolId === "http" ? (
              <>
                <Field label={t("field.bindAddress")} htmlFor="cfg-bind">
                  <input
                    id="cfg-bind"
                    className="input"
                    value={(config.bindAddress as string) ?? "0.0.0.0"}
                    onChange={(event) => set("bindAddress", event.target.value)}
                    dir="ltr"
                  />
                </Field>
                {protocolId === "socks" ? (
                  <label className="flex items-center justify-between gap-3 self-end rounded-xl border border-surface-line bg-surface/50 px-4 py-3 text-sm">
                    <span className="text-ink-muted">{t("field.udpAssociate")}</span>
                    <Toggle
                      checked={Boolean(config.udpAssociate)}
                      onChange={(value) => set("udpAssociate", value)}
                      label={t("field.udpAssociate")}
                    />
                  </label>
                ) : (
                  <>
                    <label className="flex items-center justify-between gap-3 self-end rounded-xl border border-surface-line bg-surface/50 px-4 py-3 text-sm">
                      <span className="text-ink-muted">{t("field.allowConnect")}</span>
                      <Toggle
                        checked={Boolean(config.allowConnect)}
                        onChange={(value) => set("allowConnect", value)}
                        label={t("field.allowConnect")}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-xl border border-surface-line bg-surface/50 px-4 py-3 text-sm">
                      <span className="text-ink-muted">{t("field.tlsTun")}</span>
                      <Toggle
                        checked={Boolean(config.tls)}
                        onChange={(value) => set("tls", value)}
                        label={t("field.tlsTun")}
                      />
                    </label>
                    {config.tls ? (
                      <>
                        <Field
                          label={t("field.certificateFile")}
                          htmlFor="cfg-cert"
                          hint={t("field.certificateHint")}
                        >
                          <input
                            id="cfg-cert"
                            className="input"
                            value={optional("certificateFile")}
                            onChange={(event) => setOptional("certificateFile", event.target.value)}
                            dir="ltr"
                            placeholder="/etc/ssl/fullchain.pem"
                          />
                        </Field>
                        <Field label={t("field.keyFile")} htmlFor="cfg-key">
                          <input
                            id="cfg-key"
                            className="input"
                            value={optional("keyFile")}
                            onChange={(event) => setOptional("keyFile", event.target.value)}
                            dir="ltr"
                            placeholder="/etc/ssl/privkey.pem"
                          />
                        </Field>
                      </>
                    ) : null}
                  </>
                )}
              </>
            ) : null}

            {protocolId === "mtproto" ? (
              <>
                <Field label={t("field.adTag")} htmlFor="cfg-tag" hint={t("field.adTagHint")}>
                  <input
                    id="cfg-tag"
                    className="input font-mono"
                    value={optional("adTag")}
                    onChange={(event) => setOptional("adTag", event.target.value)}
                    maxLength={32}
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.transportMode")} htmlFor="cfg-mt-proto">
                  <select
                    id="cfg-mt-proto"
                    className="select"
                    value={(config.preferredTransport as string) ?? "port"}
                    onChange={(event) => set("preferredTransport", event.target.value)}
                  >
                    <option value="port">port</option>
                    <option value="range">range</option>
                    <option value="domain">domain</option>
                  </select>
                </Field>
              </>
            ) : null}

            {protocolId === "wireguard" ? (
              <>
                <Field label={t("field.wgAddress")} htmlFor="cfg-wg-addr" required>
                  <input
                    id="cfg-wg-addr"
                    className="input font-mono"
                    value={(config.listenAddressCidr as string) ?? ""}
                    onChange={(event) => set("listenAddressCidr", event.target.value)}
                    dir="ltr"
                    placeholder="10.8.0.1/24"
                  />
                </Field>
                <Field label={t("field.wgServerPort")} htmlFor="cfg-wg-port" required>
                  <input
                    id="cfg-wg-port"
                    type="number"
                    min={1}
                    max={65535}
                    className="input"
                    value={String(config.serverPort ?? 51820)}
                    onChange={(event) => set("serverPort", num(event.target.value))}
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.wgEndpointHost")} htmlFor="cfg-wg-host" required>
                  <input
                    id="cfg-wg-host"
                    className="input"
                    value={(config.serverEndpointHost as string) ?? ""}
                    onChange={(event) => set("serverEndpointHost", event.target.value)}
                    dir="ltr"
                    placeholder="wg.example.com"
                  />
                </Field>
                <Field label={t("field.wgEndpointPort")} htmlFor="cfg-wg-endpoint-port" required>
                  <input
                    id="cfg-wg-endpoint-port"
                    type="number"
                    min={1}
                    max={65535}
                    className="input"
                    value={String(config.serverEndpointPort ?? 51820)}
                    onChange={(event) => set("serverEndpointPort", num(event.target.value))}
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.allowedIps")} htmlFor="cfg-wg-allowed">
                  <input
                    id="cfg-wg-allowed"
                    className="input font-mono"
                    value={(config.allowedIps as string) ?? ""}
                    onChange={(event) => set("allowedIps", event.target.value)}
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.dns")} htmlFor="cfg-wg-dns">
                  <input
                    id="cfg-wg-dns"
                    className="input"
                    value={
                      Array.isArray(config.clientDnsServers)
                        ? (config.clientDnsServers as string[]).join(", ")
                        : ""
                    }
                    onChange={(event) =>
                      set(
                        "clientDnsServers",
                        event.target.value
                          .split(",")
                          .map((item) => item.trim())
                          .filter(Boolean)
                      )
                    }
                    dir="ltr"
                  />
                </Field>
                <Field label={t("field.keepalive")} htmlFor="cfg-wg-keepalive">
                  <input
                    id="cfg-wg-keepalive"
                    type="number"
                    min={0}
                    max={600}
                    className="input"
                    value={String(config.keepaliveSeconds ?? 25)}
                    onChange={(event) => set("keepaliveSeconds", num(event.target.value))}
                    dir="ltr"
                  />
                </Field>
                {typeof config.serverPublicKey === "string" ? (
                  <Field
                    label={t("field.serverPublicKey")}
                    htmlFor="cfg-wg-pub"
                    hint={t("field.serverPublicKeyHint")}
                  >
                    <input
                      id="cfg-wg-pub"
                      className="input font-mono"
                      value={config.serverPublicKey}
                      readOnly
                      dir="ltr"
                    />
                  </Field>
                ) : null}
              </>
            ) : null}

            {protocolId === "openvpn" ? (
              <>
                <Field label={t("field.profileName")} htmlFor="cfg-ovpn-label" required>
                  <input
                    id="cfg-ovpn-label"
                    className="input"
                    value={(config.label as string) ?? ""}
                    onChange={(event) => set("label", event.target.value)}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field
                    label={t("field.profileText")}
                    htmlFor="cfg-ovpn-profile"
                    hint={t("field.profileTextHint")}
                  >
                    <textarea
                      id="cfg-ovpn-profile"
                      className="textarea min-h-[260px] font-mono text-xs"
                      value={(config.profileText as string) ?? ""}
                      onChange={(event) => set("profileText", event.target.value)}
                      dir="ltr"
                      spellCheck={false}
                    />
                  </Field>
                </div>
              </>
            ) : null}
          </div>
        )}

        <Field label={t("configs.notes")} htmlFor="config-notes">
          <textarea
            id="config-notes"
            className="textarea min-h-[70px]"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
          />
        </Field>

        <details className="rounded-xl border border-surface-line bg-surface/40 px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
            {t("configs.preview")}
          </summary>
          <div className="mt-3">
            <div className="mb-2 flex justify-end">
              <CopyButton value={configPreview} />
            </div>
            <pre className="code-block" dir="ltr">
              {configPreview}
            </pre>
          </div>
        </details>
        <p className="text-[11px] leading-relaxed text-ink-faint">{t("configs.serverSecurity")}</p>
      </div>
    </Modal>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
