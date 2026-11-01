import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, adminApi } from "./api";
import { ERROR_KEYS, type ErrorKey, errorKey } from "./errors";
import { ADMIN_PATHS, type AdminPath, MANAGEMENT_PATHS, navigate } from "./router";

/** Dates and times in the page language. */
export function useDateFormat() {
  const { i18n } = useTranslation();
  return (value: string | Date) =>
    new Intl.DateTimeFormat(i18n.language === "he" ? "he-IL" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
}

/** The error key for a failed admin request. */
export function failureKey(caught: unknown): ErrorKey {
  return caught instanceof AdminApiError
    ? errorKey(caught.code, caught.status)
    : ERROR_KEYS.network;
}

/** A failure that means the session is gone: the app shows the sign-in page again. */
function sessionLost(caught: unknown): boolean {
  return caught instanceof AdminApiError && (caught.status === 401 || caught.status === 403);
}

/**
 * Loads an admin resource and offers actions that reload it. A request that
 * finds the session ended hands over to onSessionLost.
 */
export function useAdminResource<T>(path: string, onSessionLost: () => Promise<void>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminApi.get<T>(path));
    } catch (caught) {
      if (sessionLost(caught)) {
        await onSessionLost();
        return;
      }
      setError(failureKey(caught));
    }
  }, [path, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change, then reloads. Returns whether it worked. */
  const act = useCallback(
    async (change: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      try {
        await change();
        await load();
        return true;
      } catch (caught) {
        if (sessionLost(caught) && (caught as AdminApiError).code !== "origin_rejected") {
          await onSessionLost();
          return false;
        }
        setError(failureKey(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onSessionLost],
  );

  return { data, error, setError, busy, act, reload: load };
}

/** User data (addresses, labels, numbers) shown as is, never translated. */
export function Value({ children, ltr = false }: { children: ReactNode; ltr?: boolean }) {
  return (
    <span data-value="" {...(ltr ? { dir: "ltr" } : {})}>
      {children}
    </span>
  );
}

const NAV_KEYS = {
  [ADMIN_PATHS.agents]: "nav.agents",
  [ADMIN_PATHS.keys]: "nav.keys",
  [ADMIN_PATHS.blocked]: "nav.blocked",
  [ADMIN_PATHS.providers]: "nav.providers",
  [ADMIN_PATHS.settings]: "nav.settings",
  [ADMIN_PATHS.home]: "nav.account",
} as const satisfies Record<(typeof MANAGEMENT_PATHS)[number], string>;

/** The admin sections. */
export function AdminNav({ current }: { current: string }) {
  const { t } = useTranslation();
  return (
    <nav className="admin-nav" aria-label={t("nav.label")}>
      <ul>
        {MANAGEMENT_PATHS.map((path) => (
          <li key={path}>
            <a
              href={path}
              className="admin-nav-link"
              aria-current={current === path ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(path as AdminPath);
              }}
            >
              {t(NAV_KEYS[path])}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A management page: heading, introduction, and content. */
export function ManagePage({
  heading,
  intro,
  children,
}: {
  heading: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="manage-page">
      <div className="admin-intro">
        <h1 className="admin-heading">{heading}</h1>
        <p className="auth-intro">{intro}</p>
      </div>
      {children}
    </div>
  );
}
