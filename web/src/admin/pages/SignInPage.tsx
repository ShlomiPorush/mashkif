import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { AuthPanel, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { ADMIN_PATHS, navigate, rememberPassword } from "../router";

/** Password, then a TOTP code or a backup code; or a passkey. */
export function SignInPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"password" | "totp" | "backup">("password");
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  const signIn = (form: FormData) =>
    run(async () => {
      const password = String(form.get("password"));
      const { data, error: failure } = await authClient.signIn.username({
        username: String(form.get("username")).trim(),
        password,
      });
      if (failure) {
        if (failure.status !== undefined && passwordRef.current !== null) {
          passwordRef.current.value = "";
          passwordRef.current.focus();
        }
        setError(authErrorKey(failure));
        return;
      }
      if (data !== null && "twoFactorRedirect" in data && data.twoFactorRedirect === true) {
        setStep("totp");
        return;
      }
      // No TOTP yet: the next page enrolls it.
      rememberPassword(password);
      await onDone();
    });

  const verify = (form: FormData) =>
    run(async () => {
      const code = String(form.get("code")).trim();
      const { error: failure } =
        step === "backup"
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code });
      if (failure) {
        const key = authErrorKey(failure);
        setError(key);
        if (key === ERROR_KEYS.signInExpired) {
          setStep("password");
        } else if (codeRef.current !== null) {
          codeRef.current.value = "";
          codeRef.current.focus();
        }
        return;
      }
      await onDone();
    });

  const passkey = () =>
    run(async () => {
      const { error: failure } = await authClient.signIn.passkey();
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      await onDone();
    });

  if (step !== "password") {
    const backup = step === "backup";
    return (
      <AuthPanel
        heading={backup ? t("signIn.backupHeading") : t("signIn.totpHeading")}
        intro={backup ? t("signIn.backupIntro") : t("signIn.totpIntro")}
      >
        <form
          key={step}
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(new FormData(event.currentTarget));
          }}
        >
          {backup ? (
            <Field
              ref={codeRef}
              label={t("signIn.backupCode")}
              name="code"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              required
              autoFocus
              className="field-input field-code"
              dir="ltr"
            />
          ) : (
            <Field
              ref={codeRef}
              label={t("signIn.code")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              className="field-input field-code"
              dir="ltr"
            />
          )}
          <Notice error={error} />
          <Button busy={busy}>{t("signIn.verify")}</Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setError(undefined);
              setStep(backup ? "totp" : "backup");
            }}
          >
            {backup ? t("signIn.useTotp") : t("signIn.useBackup")}
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setError(undefined);
              setStep("password");
            }}
          >
            {t("signIn.back")}
          </Button>
        </form>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel heading={t("signIn.heading")} intro={t("signIn.intro")}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn(new FormData(event.currentTarget));
        }}
      >
        <Field
          label={t("signIn.username")}
          name="username"
          autoComplete="username webauthn"
          required
          autoFocus
          dir="ltr"
        />
        <Field
          ref={passwordRef}
          label={t("signIn.password")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Notice error={error} />
        <Button busy={busy}>{t("signIn.submit")}</Button>
      </form>
      <div className="divider">
        <span>{t("signIn.or")}</span>
      </div>
      <Button type="button" variant="secondary" busy={busy} onClick={() => void passkey()}>
        {t("signIn.passkey")}
      </Button>
      <div className="help-block">
        <a
          className="text-link"
          href={ADMIN_PATHS.forgotPassword}
          onClick={(event) => {
            event.preventDefault();
            navigate(ADMIN_PATHS.forgotPassword);
          }}
        >
          {t("signIn.forgotLink")}
        </a>
      </div>
    </AuthPanel>
  );
}
