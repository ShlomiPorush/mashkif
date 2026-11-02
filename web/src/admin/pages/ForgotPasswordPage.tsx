import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { AuthPanel, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { ADMIN_PATHS, navigate } from "../router";

/** Asks Better Auth to email a password reset link to the admin's address. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(form: FormData) {
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.requestPasswordReset({
        email: String(form.get("email")).trim(),
        redirectTo: `${window.location.origin}${ADMIN_PATHS.resetPassword}`,
      });
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      setSent(true);
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel heading={t("forgot.heading")} intro={t("forgot.intro")}>
      {sent ? (
        <Notice>{t("forgot.sent")}</Notice>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(new FormData(event.currentTarget));
          }}
        >
          <Field
            label={t("forgot.email")}
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            dir="ltr"
          />
          <Notice error={error} />
          <Button busy={busy}>{t("forgot.submit")}</Button>
        </form>
      )}
      <div className="help-block">
        <a
          className="text-link"
          href={ADMIN_PATHS.signIn}
          onClick={(event) => {
            event.preventDefault();
            navigate(ADMIN_PATHS.signIn);
          }}
        >
          {t("forgot.back")}
        </a>
      </div>
    </AuthPanel>
  );
}
