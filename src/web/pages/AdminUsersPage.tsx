import { useEffect, useState } from "react";
import type { AdminUserDTO } from "../../shared/types.js";
import { api, apiErrorMessage, errorDetails } from "../api.js";
import { useI18n } from "../i18n.js";
import { useAuth } from "../auth.js";
import { useToast } from "../toast.js";
import {
  Alert,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
} from "../components/ui.js";

interface UsersResponse {
  users: AdminUserDTO[];
}

export function AdminUsersPage() {
  const { t, formatDate } = useI18n();
  const { user: me } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUserDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "operator" | "viewer">("operator");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    user: AdminUserDTO;
    isActive: boolean;
  } | null>(null);
  const [roleTarget, setRoleTarget] = useState<{
    user: AdminUserDTO;
    role: "admin" | "operator" | "viewer";
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.get<UsersResponse>("/api/auth/users");
      setUsers(result.users);
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

  const create = async () => {
    setFormError("");
    if (!username.trim() || password.length < 12) {
      setFormError(t("users.passwordHint"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/users", { username: username.trim(), password, role });
      toast.success(t("users.created"));
      setCreateOpen(false);
      setUsername("");
      setPassword("");
      setRole("operator");
      await load();
    } catch (err) {
      const details = errorDetails(err);
      setFormError(
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

  const setActive = async () => {
    if (!confirmTarget) return;
    setBusy(true);
    try {
      await api.patch(`/api/auth/users/${confirmTarget.user.id}`, {
        isActive: confirmTarget.isActive,
      });
      toast.success(t("users.updated"));
      setConfirmTarget(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  };

  const setRoleForUser = async () => {
    if (!roleTarget) return;
    setBusy(true);
    try {
      await api.patch(`/api/auth/users/${roleTarget.user.id}`, { role: roleTarget.role });
      toast.success(t("users.updated"));
      setRoleTarget(null);
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
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        actions={
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" className="h-4 w-4" />
            {t("users.new")}
          </button>
        }
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : users.length === 0 ? (
        <div className="card">
          <EmptyState title={t("users.empty")} icon="users" />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.username")}</th>
                <th>{t("common.role")}</th>
                <th>{t("common.status")}</th>
                <th>{t("users.lastLogin")}</th>
                <th>{t("users.createdAt")}</th>
                <th className="text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const self = user.id === me?.id;
                return (
                  <tr key={user.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-overlay text-[10px] font-bold uppercase text-accent">
                          {user.username.slice(0, 2)}
                        </span>
                        <span className="font-medium text-ink">{user.username}</span>
                        {self ? <span className="badge-accent">{t("users.you")}</span> : null}
                      </div>
                    </td>
                    <td>
                      <span className="badge-neutral">
                        {t(
                          `common.role${user.role === "admin" ? "Admin" : user.role === "operator" ? "Operator" : "Viewer"}`
                        )}
                      </span>
                    </td>
                    <td>
                      {user.isActive ? (
                        <span className="badge-ok">{t("common.active")}</span>
                      ) : (
                        <span className="badge-danger">{t("common.inactive")}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[11px] text-ink-muted">
                      {user.lastLoginAt ? formatDate(user.lastLoginAt) : t("users.neverSignedIn")}
                    </td>
                    <td className="whitespace-nowrap text-[11px] text-ink-muted">
                      {formatDate(user.createdAt, false)}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        {self ? (
                          <span className="badge-neutral">{t("users.protected")}</span>
                        ) : (
                          <>
                            <select
                              className="select w-32 py-1.5 text-xs"
                              value={user.role}
                              onChange={(event) =>
                                setRoleTarget({
                                  user,
                                  role: event.target.value as "admin" | "operator" | "viewer",
                                })
                              }
                              aria-label={t("common.role")}
                            >
                              <option value="admin">{t("common.roleAdmin")}</option>
                              <option value="operator">{t("common.roleOperator")}</option>
                              <option value="viewer">{t("common.roleViewer")}</option>
                            </select>
                            <button
                              type="button"
                              className={
                                user.isActive ? "btn-danger btn-sm" : "btn-secondary btn-sm"
                              }
                              onClick={() => setConfirmTarget({ user, isActive: !user.isActive })}
                            >
                              {user.isActive ? t("users.deactivate") : t("users.activate")}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">{t("users.roleHint")}</p>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("users.createTitle")}
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setCreateOpen(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void create()}
              disabled={busy}
            >
              {busy ? <Spinner /> : null}
              {t("common.create")}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field label={t("common.username")} htmlFor="new-user" required>
            <input
              id="new-user"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              maxLength={64}
              dir="ltr"
            />
          </Field>
          <Field
            label={t("common.password")}
            htmlFor="new-user-pass"
            hint={t("users.passwordHint")}
            required
          >
            <input
              id="new-user-pass"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              dir="ltr"
            />
          </Field>
          <Field label={t("common.role")} htmlFor="new-user-role">
            <select
              id="new-user-role"
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as "admin" | "operator" | "viewer")}
            >
              <option value="admin">{t("common.roleAdmin")}</option>
              <option value="operator">{t("common.roleOperator")}</option>
              <option value="viewer">{t("common.roleViewer")}</option>
            </select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.isActive ? t("users.activate") : t("users.deactivate")}
        message={confirmTarget?.isActive ? t("users.updated") : t("users.deactivateConfirm")}
        loading={busy}
        danger={!confirmTarget?.isActive}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => void setActive()}
      />

      <ConfirmDialog
        open={roleTarget !== null}
        title={t("common.role")}
        message={t("users.roleChangeConfirm")}
        loading={busy}
        danger={false}
        onCancel={() => setRoleTarget(null)}
        onConfirm={() => void setRoleForUser()}
      />
    </div>
  );
}
