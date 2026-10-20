import { Link } from "react-router-dom";
import { useI18n } from "../i18n.js";
import { Icon } from "../components/ui.js";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-surface-line bg-surface-overlay text-accent">
        <Icon name="search" className="h-7 w-7" />
      </div>
      <p className="mt-5 text-5xl font-bold tracking-tight text-ink">404</p>
      <h1 className="mt-3 text-lg font-semibold text-ink">{t("error.notFoundTitle")}</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">
        {t("error.notFoundBody")}
      </p>
      <Link to="/" className="btn-primary mt-5">
        <Icon name="overview" className="h-4 w-4" />
        {t("error.goHome")}
      </Link>
    </div>
  );
}

export function ForbiddenPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-warn/30 bg-warn/10 text-warn">
        <Icon name="lock" className="h-7 w-7" />
      </div>
      <h1 className="mt-5 text-lg font-semibold text-ink">{t("error.forbidden")}</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">{t("common.noAccess")}</p>
      <Link to="/" className="btn-secondary mt-5">
        <Icon name="overview" className="h-4 w-4" />
        {t("error.goHome")}
      </Link>
    </div>
  );
}
