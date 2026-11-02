import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { AuthPanel, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { ADMIN_PATHS, navigate } from "../router";

/** The token Better Auth put in the link, or undefined when it reported the link invalid. */
function tokenFromLink(): string | undefined {
  const query = new URLSearchParams(window.location.search);
  const token = query.get("token") ?? "";
  return query.get("error") === null && token !== "" ? token : undefined;
}

/** The page the emailed reset link opens: sets a new password, with or without a session. */
export function ResetPasswordPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  // Read once: navigating away drops the query.
  const [token] = useState(tokenFromLink);
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) {
      setError(ERROR_KEYS.passwordsDiffer);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.resetPassword({
        token: token ?? "",
        newPassword,
      });
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      await onDone();
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined) {
    return (
      <AuthPanel heading={t("reset.heading")}>
        <Notice error={ERROR_KEYS.resetLinkInvalid} />
        <div className="help-block">
          <a
            className="text-link"
            href={ADMIN_PATHS.forgotPassword}
            onClick={(event) => {
              event.preventDefault();
              navigate(ADMIN_PATHS.forgotPassword);
            }}
          >
            {t("reset.again")}
          </a>
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel heading={t("reset.heading")} intro={t("reset.intro")}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <Field
          label={t("reset.password")}
          help={t("setup.passwordHelp")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          autoFocus
        />
        <Field
          label={t("reset.confirm")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
        <Notice error={error} />
        <Button busy={busy}>{t("reset.submit")}</Button>
      </form>
    </AuthPanel>
  );
}
