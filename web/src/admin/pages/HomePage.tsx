import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { BackupCodes, Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";
import { useDateFormat, Value } from "../manage";

interface Passkey {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
}

function PasskeysSection({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: failure } = await authClient.passkey.listUserPasskeys();
    if (failure) {
      if (failure.status === 401 || failure.status === 403) {
        await onSessionLost();
        return;
      }
      setError(authErrorKey(failure));
      return;
    }
    setPasskeys((data ?? []) as Passkey[]);
  }, [onSessionLost]);

  useEffect(() => {
    void load().catch(() => setError(ERROR_KEYS.network));
  }, [load]);

  async function add(form: HTMLFormElement) {
    setBusy(true);
    setError(undefined);
    try {
      const name = String(new FormData(form).get("name")).trim();
      const result = await authClient.passkey.addPasskey(name === "" ? {} : { name });
      if (result?.error) {
        setError(authErrorKey(result.error));
        return;
      }
      form.reset();
      await load();
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.passkey.deletePasskey({ id });
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      await load();
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="passkeys-heading">
      <h2 id="passkeys-heading" className="card-heading">
        {t("passkeys.heading")}
      </h2>
      <p className="card-intro">{t("passkeys.intro")}</p>
      {passkeys.length === 0 ? (
        <p className="card-empty">{t("passkeys.empty")}</p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="passkey-item">
              <div>
                <p className="passkey-name">{passkey.name || t("passkeys.unnamed")}</p>
                {passkey.createdAt ? (
                  <p className="field-help">
                    {t("passkeys.added", { date: formatDate(passkey.createdAt) })}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="quiet"
                busy={busy}
                onClick={() => void remove(passkey.id)}
              >
                {t("passkeys.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="form form-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void add(event.currentTarget);
        }}
      >
        <Field label={t("passkeys.name")} name="name" maxLength={64} autoComplete="off" />
        <Button busy={busy} variant="secondary">
          {t("passkeys.add")}
        </Button>
      </form>
      <Notice error={error} />
    </section>
  );
}

/** The admin's email address: a change takes effect after the link sent to the new address. */
function EmailSection({ email }: { email: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string>();

  async function change(form: HTMLFormElement) {
    const newEmail = String(new FormData(form).get("email")).trim();
    if (newEmail.toLowerCase() === email.toLowerCase()) {
      setError(ERROR_KEYS.emailSame);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.changeEmail({ newEmail, callbackURL: "/admin" });
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      form.reset();
      setSentTo(newEmail);
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="email-heading">
      <h2 id="email-heading" className="card-heading">
        {t("account.emailHeading")}
      </h2>
      <p className="card-intro">
        {t("account.emailCurrent")} <Value ltr>{email}</Value>
      </p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void change(event.currentTarget);
        }}
      >
        <Field
          label={t("account.newEmail")}
          help={t("account.newEmailHelp")}
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          dir="ltr"
        />
        <Notice error={error}>{sentTo === undefined ? undefined : t("account.emailSent")}</Notice>
        <Button busy={busy} variant="secondary">
          {t("account.changeEmail")}
        </Button>
      </form>
    </section>
  );
}

/** New TOTP backup codes, which replace the old ones and are shown once. */
function BackupCodesSection() {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>();

  async function generate(form: HTMLFormElement) {
    setBusy(true);
    setError(undefined);
    try {
      const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({
        password: String(new FormData(form).get("password")),
      });
      if (failure || data === null) {
        setError(failure ? authErrorKey(failure) : ERROR_KEYS.unexpected);
        return;
      }
      form.reset();
      setCodes(data.backupCodes);
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="backup-heading">
      <h2 id="backup-heading" className="card-heading">
        {t("account.backupHeading")}
      </h2>
      <p className="card-intro">{t("account.backupIntro")}</p>
      {codes !== undefined && <BackupCodes codes={codes} />}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void generate(event.currentTarget);
        }}
      >
        <Field
          label={t("account.password")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Notice error={error} />
        <Button busy={busy} variant="secondary">
          {t("account.generateBackup")}
        </Button>
      </form>
    </section>
  );
}

/** The signed-in admin page: email address, backup codes, and passkeys. */
export function HomePage({
  username,
  email,
  onSessionLost,
}: {
  username: string;
  email: string;
  onSessionLost: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="admin-home">
      <div className="admin-intro">
        <h1 className="admin-heading">{t("admin.homeHeading", { username })}</h1>
      </div>
      <div className="admin-grid">
        <EmailSection email={email} />
        <BackupCodesSection />
        <PasskeysSection onSessionLost={onSessionLost} />
      </div>
    </div>
  );
}
