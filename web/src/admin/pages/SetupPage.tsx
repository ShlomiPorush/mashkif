import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { AuthPanel, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { rememberPassword } from "../router";

/** First run: Better Auth sign-up creates the one admin and signs it in. */
export function SetupPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError(ERROR_KEYS.passwordsDiffer);
      return;
    }
    const username = String(form.get("username")).trim();
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.signUp.email({
        name: username,
        username,
        email: String(form.get("email")).trim(),
        password,
      });
      if (failure) {
        const key = authErrorKey(failure);
        if (key === ERROR_KEYS.alreadySetUp) {
          // The admin exists, for example because the answer to an earlier
          // attempt was lost: the app moves on to sign-in.
          await onDone();
          return;
        }
        setError(key);
        return;
      }
      rememberPassword(password);
      await onDone();
    } catch {
      setError(ERROR_KEYS.network);
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
        <Field
          label={t("setup.username")}
          help={t("setup.usernameHelp")}
          name="username"
          autoComplete="username"
          minLength={3}
          maxLength={30}
          pattern="[A-Za-z0-9_.]+"
          required
          readOnly={busy}
          dir="ltr"
        />
        <Field
          label={t("setup.email")}
          help={t("setup.emailHelp")}
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          readOnly={busy}
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
          readOnly={busy}
        />
        <Field
          label={t("setup.confirm")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          readOnly={busy}
        />
        <Notice error={error} />
        <Button busy={busy}>{t("setup.submit")}</Button>
      </form>
    </AuthPanel>
  );
}
