import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, adminApi } from "../api";
import { AuthPanel, Button, Command, Field, Notice } from "../components";
import { ERROR_KEYS, type ErrorKey, errorKey } from "../errors";

/** A new password with a reset token from `cli.js reset-admin`. */
export function ResetPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError(ERROR_KEYS.passwordsDiffer);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await adminApi.post("/reset", { token: String(form.get("token")).trim(), password });
      await onDone();
    } catch (caught) {
      setError(
        caught instanceof AdminApiError ? errorKey(caught.code, caught.status) : ERROR_KEYS.network,
      );
    } finally {
      setBusy(false);
    }
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
        <div className="field">
          <p className="field-help">{t("reset.tokenHelp")}</p>
          <Command>{t("signIn.resetCommand")}</Command>
        </div>
        <Field
          label={t("reset.token")}
          name="token"
          autoComplete="off"
          spellCheck={false}
          required
          dir="ltr"
        />
        <Field
          label={t("reset.password")}
          help={t("setup.passwordHelp")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
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
