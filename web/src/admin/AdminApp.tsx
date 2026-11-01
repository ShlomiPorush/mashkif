import "./admin.css";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, adminApi, type SessionInfo } from "./api";
import { authClient } from "./auth-client";
import { AdminFrame, Button, Notice } from "./components";
import { ERROR_KEYS, type ErrorKey, errorKey } from "./errors";
import { HomePage } from "./pages/HomePage";
import { ResetPage } from "./pages/ResetPage";
import { SetupPage } from "./pages/SetupPage";
import { type SessionEnded, SignInPage } from "./pages/SignInPage";
import { TotpPage } from "./pages/TotpPage";
import { ADMIN_PATHS, type AdminPath, navigate, usePath } from "./router";

interface Boot {
  setupRequired: boolean;
  session: SessionInfo;
}

/** Where the admin belongs, from the server's view of setup and the session. */
export function targetPath(boot: Boot, path = ""): AdminPath {
  if (boot.setupRequired) {
    return ADMIN_PATHS.setup;
  }
  switch (boot.session.state) {
    case "none":
      // The reset page is reachable only without a session.
      return path === ADMIN_PATHS.reset ? ADMIN_PATHS.reset : ADMIN_PATHS.signIn;
    case "enrollment":
      return ADMIN_PATHS.totp;
    case "full":
      return ADMIN_PATHS.home;
  }
}

/** The admin panel under /admin, loaded only on admin pages. */
export function AdminApp() {
  const { t } = useTranslation();
  const path = usePath();
  const [boot, setBoot] = useState<Boot>();
  const [ended, setEnded] = useState<SessionEnded>();
  const [error, setError] = useState<ErrorKey>();
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [status, session] = await Promise.all([
        adminApi.get<{ setupRequired: boolean }>("/status"),
        adminApi.get<SessionInfo>("/session"),
      ]);
      if (session.state === "none" && session.ended !== undefined) {
        setEnded(session.ended);
      }
      setError(undefined);
      setBoot({ setupRequired: status.setupRequired, session });
    } catch (caught) {
      setError(
        caught instanceof AdminApiError ? errorKey(caught.code, caught.status) : ERROR_KEYS.network,
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const target = boot === undefined ? undefined : targetPath(boot, path);
  useEffect(() => {
    if (target !== undefined && path !== target) {
      navigate(target, true);
    }
  }, [path, target]);

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
      setEnded(undefined);
      await refresh();
    }
  }

  const done = async () => {
    setEnded(undefined);
    await refresh();
  };

  let page: ReactNode;
  if (boot === undefined || target === undefined) {
    page =
      error === undefined ? (
        <p className="admin-loading">{t("admin.loading")}</p>
      ) : (
        <div className="auth-panel">
          <Notice error={error} />
          <Button type="button" onClick={() => void refresh()}>
            {t("admin.retry")}
          </Button>
        </div>
      );
  } else if (target === ADMIN_PATHS.setup) {
    page = <SetupPage onDone={done} />;
  } else if (target === ADMIN_PATHS.reset) {
    page = (
      <ResetPage
        onDone={async () => {
          navigate(ADMIN_PATHS.signIn, true);
          await done();
        }}
      />
    );
  } else if (target === ADMIN_PATHS.signIn) {
    page = <SignInPage ended={ended} onDone={done} />;
  } else if (target === ADMIN_PATHS.totp) {
    page = <TotpPage onDone={done} />;
  } else if (boot.session.state === "full") {
    page = (
      <HomePage
        username={boot.session.username}
        method={boot.session.method}
        onSessionLost={refresh}
      />
    );
  }

  const signedIn = boot !== undefined && boot.session.state !== "none";
  return (
    <AdminFrame
      actions={
        signedIn ? (
          <Button type="button" variant="quiet" busy={signingOut} onClick={() => void signOut()}>
            {t("admin.signOut")}
          </Button>
        ) : undefined
      }
    >
      {page}
    </AdminFrame>
  );
}
