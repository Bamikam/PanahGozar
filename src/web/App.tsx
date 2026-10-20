import React, { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { SettingsResponse } from "../shared/types.js";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useI18n } from "./i18n.js";
import { useTheme } from "./theme.js";
import { AppLayout } from "./components/Layout.js";
import { Icon } from "./components/ui.js";
import { LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { ProtocolsPage } from "./pages/ProtocolsPage.js";
import { ClientsPage } from "./pages/ClientsPage.js";
import { ClientDetailPage } from "./pages/ClientDetailPage.js";
import { ConfigurationsPage } from "./pages/ConfigurationsPage.js";
import { SubscriptionsPage } from "./pages/SubscriptionsPage.js";
import { DiagnosticsPage } from "./pages/DiagnosticsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { DeploymentPage } from "./pages/DeploymentPage.js";
import { AdminUsersPage } from "./pages/AdminUsersPage.js";
import { ForbiddenPage, NotFoundPage } from "./pages/NotFoundPage.js";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // Do not log payloads or secrets; component stacks are sufficient.
    console.error("UI error boundary:", error instanceof Error ? error.message : "unknown");
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-surface p-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
            <Icon name="alert" className="h-7 w-7" />
          </div>
          <h1 className="mt-5 text-lg font-semibold text-ink">Something went wrong</h1>
          <p className="mt-2 max-w-sm text-sm text-ink-muted">
            The interface failed to render. Reload the page; no administrative action was performed.
          </p>
          <button
            type="button"
            className="btn-primary mt-5"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Splash() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/25">
          <Icon name="shield" className="h-7 w-7" />
        </div>
        <p className="text-sm font-semibold text-ink">{t("app.title")}</p>
        <p className="text-xs text-ink-muted">{t("common.loading")}</p>
      </div>
    </div>
  );
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <ForbiddenPage />;
  return <>{children}</>;
}

/** Applies server default language/theme until the user makes a local choice. */
function PreferencesSync() {
  const { user } = useAuth();
  const { setLang } = useI18n();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (!user) return;
    let alive = true;
    void api
      .get<SettingsResponse>("/api/settings")
      .then((response) => {
        if (!alive) return;
        try {
          if (!localStorage.getItem("pg.lang.user")) {
            setLang(response.settings.uiDefaultLanguage, { user: false });
          }
          if (!localStorage.getItem("pg.theme.user")) {
            setTheme(response.settings.uiDefaultTheme, { user: false });
          }
        } catch {
          // Storage may be blocked; runtime defaults remain active.
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, setLang, setTheme]);

  return null;
}

export function App() {
  const { user, loading } = useAuth();

  if (loading) return <Splash />;
  if (!user) return <LoginPage />;

  return (
    <ErrorBoundary>
      <PreferencesSync />
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="protocols" element={<ProtocolsPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:id" element={<ClientDetailPage />} />
          <Route path="configurations" element={<ConfigurationsPage />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="diagnostics" element={<DiagnosticsPage />} />
          <Route
            path="users"
            element={
              <AdminRoute>
                <AdminUsersPage />
              </AdminRoute>
            }
          />
          <Route
            path="audit"
            element={
              <AdminRoute>
                <AuditPage />
              </AdminRoute>
            }
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="deployment" element={<DeploymentPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
