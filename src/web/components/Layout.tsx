import React, { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.js";
import { useI18n } from "../i18n.js";
import { useTheme } from "../theme.js";
import { Icon, type IconName } from "./ui.js";

interface NavItem {
  to: string;
  labelKey: string;
  icon: IconName;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", labelKey: "nav.overview", icon: "overview" },
  { to: "/protocols", labelKey: "nav.protocols", icon: "protocols" },
  { to: "/clients", labelKey: "nav.clients", icon: "clients" },
  { to: "/configurations", labelKey: "nav.configurations", icon: "configs" },
  { to: "/subscriptions", labelKey: "nav.subscriptions", icon: "subscriptions" },
  { to: "/diagnostics", labelKey: "nav.diagnostics", icon: "diagnostics" },
  { to: "/users", labelKey: "nav.users", icon: "users", adminOnly: true },
  { to: "/audit", labelKey: "nav.audit", icon: "audit", adminOnly: true },
  { to: "/settings", labelKey: "nav.settings", icon: "settings" },
  { to: "/deployment", labelKey: "nav.deployment", icon: "deployment" },
];

const TITLES: Record<string, string> = {
  "/": "nav.overview",
  "/protocols": "nav.protocols",
  "/clients": "nav.clients",
  "/configurations": "nav.configurations",
  "/subscriptions": "nav.subscriptions",
  "/diagnostics": "nav.diagnostics",
  "/users": "nav.users",
  "/audit": "nav.audit",
  "/settings": "nav.settings",
  "/deployment": "nav.deployment",
};

function SidebarContent({
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin), [isAdmin]);

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
      navigate("/", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-center gap-3 px-4 py-5 ${collapsed ? "justify-center" : ""}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/25">
          <Icon name="shield" className="h-5 w-5" />
        </div>
        {!collapsed ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-bold tracking-tight text-ink">{t("app.title")}</p>
            <p className="truncate text-[11px] text-ink-faint">{t("app.tagline")}</p>
          </div>
        ) : null}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4" aria-label="Primary">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={onNavigate}
            title={collapsed ? t(item.labelKey) : undefined}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link-active" : ""} ${collapsed ? "justify-center px-0" : ""}`
            }
          >
            <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
            {!collapsed ? <span className="truncate">{t(item.labelKey)}</span> : null}
          </NavLink>
        ))}
      </nav>

      {!collapsed ? (
        <div className="mx-3 mb-3 rounded-xl border border-surface-line bg-surface/60 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">
            {t("settings.listeners")}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
            {t("settings.listenersOff")}
          </p>
        </div>
      ) : null}

      <div
        className={`border-t border-surface-line p-3 ${collapsed ? "flex flex-col items-center gap-2" : ""}`}
      >
        {!collapsed ? (
          <div className="mb-2 flex items-center gap-2.5 rounded-xl px-2 py-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-overlay text-xs font-bold uppercase text-accent">
              {user?.username.slice(0, 2) ?? "—"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-ink">{user?.username}</p>
              <p className="text-[10px] text-ink-faint">
                {t(
                  `common.role${user?.role === "admin" ? "Admin" : user?.role === "operator" ? "Operator" : "Viewer"}`
                )}
              </p>
            </div>
          </div>
        ) : null}
        <div className={`flex ${collapsed ? "flex-col" : "justify-between"} gap-1`}>
          <button
            type="button"
            className={`btn-ghost ${collapsed ? "icon-btn h-9 w-9" : "btn-sm flex-1 justify-start"}`}
            onClick={() => void doLogout()}
            disabled={busy}
            aria-label={t("common.signOut")}
            title={t("common.signOut")}
          >
            <Icon name="logout" className="h-4 w-4" />
            {!collapsed ? t("common.signOut") : null}
          </button>
          {onToggleCollapse ? (
            <button
              type="button"
              className="icon-btn hidden lg:inline-flex"
              onClick={onToggleCollapse}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <Icon
                name={collapsed ? "chevron-right" : "chevron-left"}
                className="h-4 w-4 rtl:rotate-180"
              />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { t, lang, setLang, dir } = useI18n();
  const { theme, toggle } = useTheme();
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("pg.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    document.title = `${t(TITLES[location.pathname] ?? "app.title")} · ${t("app.title")}`;
  }, [location.pathname, t]);

  useEffect(() => {
    try {
      localStorage.setItem("pg.sidebar", collapsed ? "collapsed" : "expanded");
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const currentTitle = useMemo(() => {
    if (location.pathname.startsWith("/clients/")) return t("clients.detailTitle");
    if (location.pathname.startsWith("/configurations")) return t("nav.configurations");
    return t(TITLES[location.pathname] ?? "app.title");
  }, [location.pathname, t]);

  return (
    <div className="flex min-h-screen">
      <a href="#main-content" className="sr-only-focusable fixed start-4 top-4 z-[120] btn-primary">
        Skip to content
      </a>

      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-e border-surface-line bg-surface-raised/70 backdrop-blur-xl transition-[width] duration-200 lg:block ${
          collapsed ? "w-[76px]" : "w-[260px]"
        }`}
      >
        <SidebarContent
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
        />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            aria-label={t("common.close")}
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 start-0 w-[280px] border-e border-surface-line bg-surface-raised shadow-2xl">
            <div className="flex justify-end pe-2 pt-2">
              <button
                type="button"
                className="icon-btn"
                onClick={() => setMobileOpen(false)}
                aria-label={t("common.close")}
              >
                <Icon name="close" />
              </button>
            </div>
            <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-surface-line bg-surface/80 px-4 backdrop-blur-xl sm:px-6">
          <button
            type="button"
            className="icon-btn lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{currentTitle}</p>
            <p className="hidden truncate text-[11px] text-ink-faint sm:block">{t("app.short")}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost btn-sm inline-flex"
              onClick={() => setLang(lang === "en" ? "fa" : "en")}
              aria-label={t("common.language")}
              title={t("common.language")}
            >
              <Icon name="globe" className="h-4 w-4" />
              <span className={lang === "fa" ? "font-sans" : ""}>
                {lang === "en" ? "فارسی" : "EN"}
              </span>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={toggle}
              aria-label={t("common.theme")}
              title={theme === "dark" ? t("common.light") : t("common.dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} className="h-[18px] w-[18px]" />
            </button>
            <div className="ms-1 hidden items-center gap-2 rounded-full border border-surface-line bg-surface-raised px-2 py-1 sm:flex">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold uppercase text-accent">
                {user?.username.slice(0, 2)}
              </span>
              <span className="max-w-[120px] truncate text-xs text-ink-muted">
                {user?.username}
              </span>
            </div>
          </div>
        </header>

        <main
          id="main-content"
          className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
          dir={dir}
        >
          <Outlet />
        </main>

        <footer className="border-t border-surface-line/70 px-4 py-4 text-center text-[11px] text-ink-faint sm:px-6">
          {t("app.title")} · {t("auth.footer")}
        </footer>
      </div>
    </div>
  );
}
