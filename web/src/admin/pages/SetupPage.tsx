import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, adminApi } from "../api";
import { authClient } from "../auth-client";
import { AuthPanel, Button, Command, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey, errorKey } from "../errors";
import { rememberPassword } from "../router";

/** First run: creates the one admin with a setup token from the server. */
export function SetupPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  // Once the account exists, a retry only signs in.
  const [created, setCreated] = useState<{ username: string; password: string }>();

  async function submit(form: FormData) {
    let account = created;
    if (account === undefined) {
      const password = String(form.get("password"));
      if (password !== String(form.get("confirm"))) {
        setError(ERROR_KEYS.passwordsDiffer);
        return;
      }
      account = { username: String(form.get("username")).trim(), password };
    }
    setBusy(true);
    setError(undefined);
    try {
      if (created === undefined) {
        await adminApi.post("/setup", { token: String(form.get("token")).trim(), ...account });
        setCreated(account);
      }
      const { error: signInError } = await authClient.signIn.username(account);
      if (signInError) {
        setError(authErrorKey(signInError));
        return;
      }
      rememberPassword(account.password);
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
    <AuthPanel heading={t("setup.heading")} intro={t("setup.intro")}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <div className="field">
          <p className="field-help">{t("setup.tokenHelp")}</p>
          <Command>{t("setup.command")}</Command>
        </div>
        <Field
          label={t("setup.token")}
          name="token"
          autoComplete="off"
          spellCheck={false}
          required
          readOnly={busy || created !== undefined}
          dir="ltr"
        />
        <Field
          label={t("setup.username")}
          help={t("setup.usernameHelp")}
          name="username"
          autoComplete="username"
          minLength={3}
          maxLength={30}
          pattern="[A-Za-z0-9_.]+"
          required
          readOnly={busy || created !== undefined}
          dir="ltr"
        />
        <Field
          label={t("setup.password")}
          help={t("setup.passwordHelp")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          readOnly={busy || created !== undefined}
        />
        <Field
          label={t("setup.confirm")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          readOnly={busy || created !== undefined}
        />
        <Notice error={error}>{created !== undefined ? t("setup.created") : undefined}</Notice>
        <Button busy={busy}>{created === undefined ? t("setup.submit") : t("setup.signIn")}</Button>
      </form>
    </AuthPanel>
  );
}
