import React, { useEffect, useState } from "react";
import { useAuth } from "../auth.js";
import { useI18n } from "../i18n.js";
import { useTheme } from "../theme.js";
import { api, apiErrorMessage } from "../api.js";
import { Alert, Field, Icon, Spinner } from "../components/ui.js";
import { useToast } from "../toast.js";

interface SetupStatus {
  needsSetup: boolean;
  setupEnabled: boolean;
  initialized: boolean;
  databaseReachable: boolean;
}

function PasswordInput({
  id,
  value,
  onChange,
  label,
  autoComplete,
  required,
  hint,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  autoComplete: string;
  required?: boolean;
  hint?: string;
  error?: string;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className={`input pe-11 ${error ? "input-error" : ""}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required={required}
          dir="ltr"
        />
        <button
          type="button"
          className="absolute inset-y-0 end-2 my-auto flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint hover:text-ink"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? t("common.hide") : t("common.show")}
        >
          <Icon name={visible ? "eye-off" : "eye"} className="h-4 w-4" />
        </button>
      </div>
    </Field>
  );
}

export function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  const { login } = useAuth();
  const toast = useToast();

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = async () => {
    setStatusLoading(true);
    try {
      const result = await api.get<SetupStatus>("/api/setup/status");
      setStatus(result);
      if (result.needsSetup) setMode("setup");
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(apiErrorMessage(err, t("auth.invalidCredentials")));
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setFieldError("");
    if (password.length < 12) {
      setFieldError(t("auth.passwordPolicy"));
      return;
    }
    if (password !== confirm) {
      setFieldError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await api.postWithHeaders(
        "/api/setup",
        { username: username.trim(), password },
        { "x-setup-token": setupToken }
      );
      toast.success(t("auth.setupDone"));
      setMode("login");
      setPassword("");
      setConfirm("");
      setSetupToken("");
      await loadStatus();
    } catch (err) {
      setError(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  };

  const setupBlocked = status?.needsSetup && !status.setupEnabled;

  return (
    <div className="relative flex min-h-screen flex-col lg:flex-row">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -start-32 top-1/4 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute -end-20 bottom-0 h-80 w-80 rounded-full bg-accent-strong/10 blur-3xl" />
      </div>

      <div className="relative flex flex-1 flex-col justify-between px-5 py-6 sm:px-10 lg:px-14 lg:py-10">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/25">
              <Icon name="shield" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">{t("app.title")}</p>
              <p className="text-[11px] text-ink-faint">{t("app.tagline")}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setLang(lang === "en" ? "fa" : "en")}
              aria-label={t("common.language")}
            >
              <Icon name="globe" className="h-4 w-4" />
              {lang === "en" ? "فارسی" : "EN"}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={toggle}
              aria-label={t("common.theme")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        <div className="mx-auto w-full max-w-md animate-fade-up py-10 lg:py-16">
          <h1 className="text-3xl font-bold tracking-tight text-ink">
            {mode === "setup" ? t("auth.setupTitle") : t("auth.loginTitle")}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            {mode === "setup" ? t("auth.setupSubtitle") : t("auth.loginSubtitle")}
          </p>

          {error ? (
            <div className="mt-6">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          {statusLoading ? (
            <div className="mt-8 flex items-center gap-3 text-sm text-ink-muted">
              <Spinner className="h-5 w-5 text-accent" />
              {t("auth.initializing")}
            </div>
          ) : setupBlocked ? (
            <div className="mt-6 space-y-4">
              <Alert tone="warn" title={t("auth.noAdmin")}>
                {t("auth.setupDisabled")}
              </Alert>
              <button type="button" className="btn-secondary" onClick={() => void loadStatus()}>
                <Icon name="refresh" className="h-4 w-4" />
                {t("common.retry")}
              </button>
            </div>
          ) : status && !status.databaseReachable ? (
            <div className="mt-6">
              <Alert tone="danger">{t("error.server")}</Alert>
            </div>
          ) : mode === "setup" ? (
            <form className="mt-7 space-y-4" onSubmit={(event) => void submitSetup(event)}>
              <Field
                label={t("auth.setupToken")}
                htmlFor="setup-token"
                hint={t("auth.setupTokenHint")}
                required
              >
                <input
                  id="setup-token"
                  className="input"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  autoComplete="off"
                  required
                  dir="ltr"
                />
              </Field>
              <Field label={t("common.username")} htmlFor="setup-username" required>
                <input
                  id="setup-username"
                  className="input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  minLength={3}
                  maxLength={64}
                  required
                  dir="ltr"
                />
              </Field>
              <PasswordInput
                id="setup-password"
                value={password}
                onChange={setPassword}
                label={t("common.password")}
                autoComplete="new-password"
                hint={t("auth.passwordPolicy")}
                required
              />
              <PasswordInput
                id="setup-confirm"
                value={confirm}
                onChange={setConfirm}
                label={t("auth.confirmPassword")}
                autoComplete="new-password"
                required
                error={fieldError || undefined}
              />
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? <Spinner /> : <Icon name="lock" className="h-4 w-4" />}
                {busy ? t("auth.setupWorking") : t("auth.setupButton")}
              </button>
            </form>
          ) : (
            <form className="mt-7 space-y-4" onSubmit={(event) => void submitLogin(event)}>
              {status?.initialized ? null : (
                <Alert tone="warn" title={t("auth.noAdmin")}>
                  {t("auth.setupAlreadyDone")}
                </Alert>
              )}
              <Field label={t("common.username")} htmlFor="login-username" required>
                <input
                  id="login-username"
                  className="input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                  dir="ltr"
                />
              </Field>
              <PasswordInput
                id="login-password"
                value={password}
                onChange={setPassword}
                label={t("common.password")}
                autoComplete="current-password"
                required
              />
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? <Spinner /> : <Icon name="lock" className="h-4 w-4" />}
                {busy ? t("auth.signingIn") : t("auth.signIn")}
              </button>
              <p className="flex items-center gap-2 text-[11px] leading-relaxed text-ink-faint">
                <Icon name="shield" className="h-3.5 w-3.5 shrink-0" />
                {t("auth.securityNote")}
              </p>
            </form>
          )}
        </div>

        <p className="mx-auto max-w-md text-center text-[11px] leading-relaxed text-ink-faint lg:mx-0 lg:text-start">
          {t("auth.footer")}
        </p>
      </div>

      <div className="relative hidden w-[46%] flex-col justify-between border-s border-surface-line bg-surface-raised/50 p-10 backdrop-blur-xl lg:flex">
        <div>
          <span className="badge-accent">{t("app.tagline")}</span>
          <h2 className="mt-8 text-3xl font-bold leading-snug tracking-tight text-ink">
            {t("overview.quickStart")}
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-muted">
            {t("overview.quickStartDesc")}
          </p>
          <ol className="mt-8 space-y-4">
            {[
              "overview.stepProtocol",
              "overview.stepClient",
              "overview.stepAssign",
              "overview.stepSubscribe",
            ].map((key, index) => (
              <li key={key} className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-surface-line bg-surface text-xs font-bold text-accent">
                  {index + 1}
                </span>
                <span className="pt-1 text-sm text-ink-muted">{t(key)}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-2xl border border-warn/20 bg-warn/5 p-4">
          <div className="flex items-center gap-2 text-warn">
            <Icon name="alert" className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-wider">
              {t("common.unsupported")}
            </p>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            {t("overview.zeroVerified")}
          </p>
        </div>
      </div>
    </div>
  );
}
