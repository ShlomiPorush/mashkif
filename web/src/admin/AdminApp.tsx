import "./admin.css";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, adminApi, type SessionInfo } from "./api";
import { authClient } from "./auth-client";
import { AdminFrame, Button, Notice } from "./components";
import { ERROR_KEYS, type ErrorKey, errorKey } from "./errors";
import { AdminNav } from "./manage";
import { AgentsPage } from "./pages/AgentsPage";
import { BlockedPage } from "./pages/BlockedPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { HomePage } from "./pages/HomePage";
import { KeysPage } from "./pages/KeysPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SignInPage } from "./pages/SignInPage";
import { TotpPage } from "./pages/TotpPage";
import { ADMIN_PATHS, type AdminPath, isManagementPath, navigate, usePath } from "./router";

interface Boot {
  setupRequired: boolean;
  session: SessionInfo;
}

/** Where the admin belongs, from the server's view of setup and the session. */
export function targetPath(boot: Boot, path = ""): AdminPath {
  if (boot.setupRequired) {
    return ADMIN_PATHS.setup;
  }
  // The emailed reset link works with or without a session.
  if (path === ADMIN_PATHS.resetPassword) {
    return ADMIN_PATHS.resetPassword;
  }
  switch (boot.session.state) {
    case "none":
      return path === ADMIN_PATHS.forgotPassword ? ADMIN_PATHS.forgotPassword : ADMIN_PATHS.signIn;
    case "enrollment":
      return ADMIN_PATHS.totp;
    case "full":
      return isManagementPath(path) ? path : ADMIN_PATHS.home;
  }
}

/** Better Auth's session, and whether the admin has TOTP (the admin API requires it). */
async function readSession(): Promise<SessionInfo> {
  const { data, error } = await authClient.getSession();
  if (error) {
    throw new AdminApiError(error.status ?? 0, error.code ?? "unexpected");
  }
  if (data === null) {
    return { state: "none" };
  }
  const user = data.user as typeof data.user & {
    username?: string | null;
    twoFactorEnabled?: boolean | null;
  };
  return {
    state: user.twoFactorEnabled === true ? "full" : "enrollment",
    username: user.username ?? user.name,
    email: user.email,
  };
}

/** The admin panel under /admin, loaded only on admin pages. */
export function AdminApp() {
  const { t } = useTranslation();
  const path = usePath();
  const [boot, setBoot] = useState<Boot>();
  const [error, setError] = useState<ErrorKey>();
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [status, session] = await Promise.all([
        adminApi.get<{ setupRequired: boolean }>("/status"),
        readSession(),
      ]);
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
      await refresh();
    }
  }

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
    page = <SetupPage onDone={refresh} />;
  } else if (target === ADMIN_PATHS.resetPassword) {
    page = (
      <ResetPasswordPage
        onDone={async () => {
          navigate(ADMIN_PATHS.signIn, true);
          await refresh();
        }}
      />
    );
  } else if (target === ADMIN_PATHS.forgotPassword) {
    page = <ForgotPasswordPage />;
  } else if (target === ADMIN_PATHS.signIn) {
    page = <SignInPage onDone={refresh} />;
  } else if (target === ADMIN_PATHS.totp) {
    page = <TotpPage onDone={refresh} />;
  } else if (boot.session.state === "full") {
    let content: ReactNode;
    switch (target) {
      case ADMIN_PATHS.agents:
        content = <AgentsPage onSessionLost={refresh} />;
        break;
      case ADMIN_PATHS.keys:
        content = <KeysPage onSessionLost={refresh} />;
        break;
      case ADMIN_PATHS.blocked:
        content = <BlockedPage onSessionLost={refresh} />;
        break;
      case ADMIN_PATHS.providers:
        content = <ProvidersPage onSessionLost={refresh} />;
        break;
      case ADMIN_PATHS.settings:
        content = <SettingsPage onSessionLost={refresh} />;
        break;
      default:
        content = (
          <HomePage
            username={boot.session.username}
            email={boot.session.email}
            onSessionLost={refresh}
          />
        );
    }
    page = (
      <div className="admin-workspace">
        <AdminNav current={target} />
        {content}
      </div>
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
