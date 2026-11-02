import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { AuthPanel, BackupCodes, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { takeRememberedPassword } from "../router";

interface Enrollment {
  qr: string;
  key: string;
  /** Shown once, here; Better Auth stores them encrypted. */
  backupCodes: string[];
}

/** The secret of an otpauth:// URI, in groups of four for typing by hand. */
function manualKey(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** The QR code as an SVG data URL: drawn here, never fetched, so the CSP needs nothing new. */
async function qrDataUrl(uri: string): Promise<string> {
  const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Mandatory TOTP enrollment: the admin API needs it, and it shows the backup codes once. */
export function TotpPage({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function start(password: string) {
    setBusy(true);
    setError(undefined);
    try {
      const { data, error: failure } = await authClient.twoFactor.enable({ password });
      if (failure || data === null || !("totpURI" in data)) {
        setError(failure ? authErrorKey(failure) : ERROR_KEYS.unexpected);
        return;
      }
      setEnrollment({
        qr: await qrDataUrl(data.totpURI),
        key: manualKey(data.totpURI),
        backupCodes: data.backupCodes,
      });
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const password = takeRememberedPassword();
    if (password !== undefined) {
      void start(password);
    }
  });

  async function verify(code: string) {
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.twoFactor.verifyTotp({ code });
      if (failure) {
        setError(authErrorKey(failure));
        if (codeRef.current !== null) {
          codeRef.current.value = "";
          codeRef.current.focus();
        }
        return;
      }
      await onDone();
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  if (enrollment === undefined) {
    return (
      <AuthPanel heading={t("totp.heading")} intro={t("totp.intro")}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void start(String(new FormData(event.currentTarget).get("password")));
          }}
        >
          <p className="field-help">{t("totp.confirmPassword")}</p>
          <Field
            label={t("totp.password")}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Notice error={error} />
          <Button busy={busy}>{t("totp.start")}</Button>
        </form>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel heading={t("totp.heading")} intro={t("totp.scan")}>
      <div className="totp-setup">
        <img
          className="totp-qr"
          src={enrollment.qr}
          alt={t("totp.qrAlt")}
          width={220}
          height={220}
        />
        <div className="totp-manual">
          <p className="field-help">{t("totp.manual")}</p>
          <code className="command totp-key" dir="ltr">
            {enrollment.key}
          </code>
        </div>
      </div>
      <BackupCodes codes={enrollment.backupCodes} />
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void verify(String(new FormData(event.currentTarget).get("code")).trim());
        }}
      >
        <Field
          ref={codeRef}
          label={t("totp.code")}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className="field-input field-code"
          dir="ltr"
        />
        <Notice error={error} />
        <Button busy={busy}>{t("totp.verify")}</Button>
      </form>
    </AuthPanel>
  );
}
