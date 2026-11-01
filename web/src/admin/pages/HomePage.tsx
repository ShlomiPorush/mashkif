import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client";
import { Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey } from "../errors";

interface Passkey {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
}

function useDateFormat() {
  const { i18n } = useTranslation();
  return (value: string | Date) =>
    new Intl.DateTimeFormat(i18n.language === "he" ? "he-IL" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
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

/** The signed-in admin page: passkeys. */
export function HomePage({
  username,
  method,
  onSessionLost,
}: {
  username: string;
  method: "password" | "totp" | "passkey";
  onSessionLost: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="admin-home">
      <div className="admin-intro">
        <h1 className="admin-heading">{t("admin.homeHeading", { username })}</h1>
        <p className="auth-intro">
          {method === "passkey" ? t("admin.viaPasskey") : t("admin.viaPasswordTotp")}
        </p>
      </div>
      <div className="admin-grid">
        <PasskeysSection onSessionLost={onSessionLost} />
      </div>
    </div>
  );
}
