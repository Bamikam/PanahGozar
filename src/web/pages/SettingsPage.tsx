import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SettingsResponse } from "../../shared/types.js";
import { api, apiErrorMessage } from "../api.js";
import { useI18n, type Lang } from "../i18n.js";
import { useTheme } from "../theme.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ErrorState,
  Field,
  Icon,
  InfoRow,
  LoadingBlock,
  PageHeader,
  Spinner,
} from "../components/ui.js";

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const { user, isAdmin, logout } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({
    uiDefaultLanguage: "en" as Lang,
    uiDefaultTheme: "dark" as "dark" | "light",
    subscriptionDefaultFormat: "xray_uri" as "xray_uri" | "raw_uri" | "singbox_json",
    subscriptionMaxPerClient: 10,
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.get<SettingsResponse>("/api/settings");
      setData(result);
      setDefaults({
        uiDefaultLanguage: result.settings.uiDefaultLanguage,
        uiDefaultTheme: result.settings.uiDefaultTheme,
        subscriptionDefaultFormat: result.settings.subscriptionDefaultFormat,
        subscriptionMaxPerClient: result.settings.subscriptionMaxPerClient,
      });
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

  const save = async () => {
    setSaving(true);
    try {
      await api.patch("/api/settings", defaults);
      toast.success(t("settings.saved"));
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setPasswordError("");
    if (newPassword.length < 12) {
      setPasswordError(t("auth.passwordPolicy"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("auth.passwordMismatch"));
      return;
    }
    setPasswordBusy(true);
    try {
      await api.post("/api/auth/password", { currentPassword, newPassword });
      toast.success(t("auth.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await logout().catch(() => {});
    } catch (err) {
      setPasswordError(apiErrorMessage(err, t("common.error")));
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="section-title">{t("settings.defaults")}</h2>
                <p className="mt-1 text-xs text-ink-muted">{t("settings.defaultsHint")}</p>
              </div>
            </div>
            <div className="card-body space-y-4">
              {!isAdmin ? <Alert tone="warn">{t("settings.roleReadOnly")}</Alert> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.language")} htmlFor="settings-lang">
                  <select
                    id="settings-lang"
                    className="select"
                    value={defaults.uiDefaultLanguage}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        uiDefaultLanguage: event.target.value as Lang,
                      }))
                    }
                    disabled={!isAdmin}
                  >
                    <option value="en">English</option>
                    <option value="fa">فارسی</option>
                  </select>
                </Field>
                <Field label={t("settings.theme")} htmlFor="settings-theme">
                  <select
                    id="settings-theme"
                    className="select"
                    value={defaults.uiDefaultTheme}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        uiDefaultTheme: event.target.value as "dark" | "light",
                      }))
                    }
                    disabled={!isAdmin}
                  >
                    <option value="dark">{t("common.dark")}</option>
                    <option value="light">{t("common.light")}</option>
                  </select>
                </Field>
              </div>
              <Field label={t("settings.subFormat")} htmlFor="settings-sub-format">
                <select
                  id="settings-sub-format"
                  className="select"
                  value={defaults.subscriptionDefaultFormat}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      subscriptionDefaultFormat: event.target.value as
                        "xray_uri" | "raw_uri" | "singbox_json",
                    }))
                  }
                  disabled={!isAdmin}
                >
                  <option value="xray_uri">{t("subs.format.xray_uri")}</option>
                  <option value="raw_uri">{t("subs.format.raw_uri")}</option>
                  <option value="singbox_json">{t("subs.format.singbox_json")}</option>
                </select>
              </Field>
              <Field label={t("settings.maxSubs")} htmlFor="settings-max-subs">
                <input
                  id="settings-max-subs"
                  type="number"
                  min={1}
                  max={50}
                  className="input"
                  value={defaults.subscriptionMaxPerClient}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      subscriptionMaxPerClient: Number(event.target.value),
                    }))
                  }
                  disabled={!isAdmin}
                  dir="ltr"
                />
              </Field>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void save()}
                  disabled={!isAdmin || saving}
                >
                  {saving ? <Spinner /> : <Icon name="check" className="h-4 w-4" />}
                  {t("settings.save")}
                </button>
              </div>
              <div className="rounded-xl border border-surface-line bg-surface/40 p-3">
                <p className="text-[11px] text-ink-faint">{t("settings.themeLocal")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setLang(lang === "en" ? "fa" : "en")}
                  >
                    <Icon name="globe" className="h-4 w-4" />
                    {lang === "en" ? "فارسی" : "English"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                  >
                    <Icon name={theme === "dark" ? "sun" : "moon"} className="h-4 w-4" />
                    {theme === "dark" ? t("common.light") : t("common.dark")}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <div className="space-y-5">
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="section-title">{t("settings.security")}</h2>
                  <p className="mt-1 text-xs text-ink-muted">{t("settings.passwordHint")}</p>
                </div>
                <Icon name="lock" className="h-4 w-4 text-accent" />
              </div>
              <div className="card-body space-y-4">
                {passwordError ? <Alert tone="danger">{passwordError}</Alert> : null}
                <Field label={t("auth.currentPassword")} htmlFor="pw-current">
                  <input
                    id="pw-current"
                    type="password"
                    className="input"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    autoComplete="current-password"
                    dir="ltr"
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t("auth.newPassword")}
                    htmlFor="pw-new"
                    hint={t("auth.passwordPolicy")}
                  >
                    <input
                      id="pw-new"
                      type="password"
                      className="input"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                      dir="ltr"
                    />
                  </Field>
                  <Field label={t("auth.confirmPassword")} htmlFor="pw-confirm">
                    <input
                      id="pw-confirm"
                      type="password"
                      className="input"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      autoComplete="new-password"
                      dir="ltr"
                    />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void changePassword()}
                    disabled={passwordBusy || !currentPassword || !newPassword}
                  >
                    {passwordBusy ? <Spinner /> : <Icon name="key" className="h-4 w-4" />}
                    {t("auth.changePassword")}
                  </button>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <h2 className="section-title">{t("settings.runtimeInfo")}</h2>
                <span className="badge-neutral">{user?.role}</span>
              </div>
              <dl className="px-5 py-2">
                <InfoRow
                  label={t("settings.publicUrl")}
                  value={<span dir="ltr">{data.runtime.publicUrl}</span>}
                />
                <InfoRow
                  label={t("settings.environment")}
                  value={<span dir="ltr">{data.runtime.nodeEnv}</span>}
                />
                <InfoRow
                  label={t("settings.nodeVersion")}
                  value={<span dir="ltr">{data.runtime.nodeVersion}</span>}
                />
                <InfoRow
                  label={t("settings.listeners")}
                  value={
                    data.runtime.runtimeListenersEnabled
                      ? t("common.active")
                      : t("settings.listenersOff")
                  }
                />
                <InfoRow
                  label={t("settings.keepAlive")}
                  value={
                    data.runtime.keepAliveEnabled
                      ? t("settings.keepAliveOn", {
                          minutes: data.runtime.keepAliveIntervalMinutes,
                        })
                      : t("settings.keepAliveOff")
                  }
                />
                <InfoRow
                  label={t("settings.installation")}
                  value={data.settings.installationComplete ? t("diag.yes") : t("diag.no")}
                />
              </dl>
            </section>

            {isAdmin ? (
              <section className="card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="section-title">{t("settings.adminUsers")}</h2>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      {t("settings.adminUsersHint")}
                    </p>
                  </div>
                  <Icon name="users" className="h-5 w-5 text-accent" />
                </div>
                <Link to="/users" className="btn-secondary btn-sm mt-4">
                  <Icon name="users" className="h-4 w-4" />
                  {t("settings.manageUsers")}
                </Link>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
