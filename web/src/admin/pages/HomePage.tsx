import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminApiError, type AuditEntry, adminApi } from "../api";
import { authClient } from "../auth-client";
import { Button, Field, Notice } from "../components";
import { authErrorKey, ERROR_KEYS, type ErrorKey, errorKey } from "../errors";

interface Passkey {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
}

/** Audit actions with a label, keyed by the action the server records. */
const ACTION_KEYS = {
  "admin.setup_token_created": "activity.adminSetupTokenCreated",
  "admin.created": "activity.adminCreated",
  "admin.reset": "activity.adminReset",
  "sign_in.succeeded": "activity.signInSucceeded",
  "sign_in.failed": "activity.signInFailed",
  "sign_in.rate_limited": "activity.signInRateLimited",
  sign_out: "activity.signOut",
  "totp.enrolled": "activity.totpEnrolled",
  "passkey.added": "activity.passkeyAdded",
  "passkey.removed": "activity.passkeyRemoved",
  "password.changed": "activity.passwordChanged",
} as const;

const WAY_KEYS = {
  password: "activity.wayPassword",
  password_totp: "activity.wayPasswordTotp",
  passkey: "activity.wayPasskey",
  totp: "activity.wayTotp",
} as const;

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

function PasswordSection() {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorKey>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(form: HTMLFormElement) {
    const fields = new FormData(form);
    const newPassword = String(fields.get("newPassword"));
    setDone(false);
    if (newPassword !== String(fields.get("confirm"))) {
      setError(ERROR_KEYS.passwordsDiffer);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { error: failure } = await authClient.changePassword({
        currentPassword: String(fields.get("currentPassword")),
        newPassword,
        revokeOtherSessions: true,
      });
      if (failure) {
        setError(authErrorKey(failure));
        return;
      }
      form.reset();
      setDone(true);
    } catch {
      setError(ERROR_KEYS.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="password-heading">
      <h2 id="password-heading" className="card-heading">
        {t("password.heading")}
      </h2>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <Field
          label={t("password.current")}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          label={t("password.new")}
          help={t("setup.passwordHelp")}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Field
          label={t("password.confirm")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
        <Notice error={error}>{done ? t("password.changed") : undefined}</Notice>
        <Button busy={busy} variant="secondary">
          {t("password.submit")}
        </Button>
      </form>
    </section>
  );
}

function ActivitySection({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [error, setError] = useState<ErrorKey>();

  useEffect(() => {
    adminApi
      .get<{ entries: AuditEntry[] }>("/audit")
      .then((result) => setEntries(result.entries))
      .catch(async (caught: unknown) => {
        if (caught instanceof AdminApiError && (caught.status === 401 || caught.status === 403)) {
          await onSessionLost();
          return;
        }
        setError(
          caught instanceof AdminApiError
            ? errorKey(caught.code, caught.status)
            : ERROR_KEYS.network,
        );
      });
  }, [onSessionLost]);

  const label = (entry: AuditEntry) => {
    const key = ACTION_KEYS[entry.action as keyof typeof ACTION_KEYS];
    const way = entry.details?.method ?? entry.details?.step;
    const wayKey = WAY_KEYS[way as keyof typeof WAY_KEYS];
    const text = key === undefined ? entry.action : t(key);
    return wayKey === undefined ? text : `${text} · ${t(wayKey)}`;
  };

  return (
    <section className="admin-card admin-card-wide" aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="card-heading">
        {t("activity.heading")}
      </h2>
      <Notice error={error} />
      {entries !== undefined && entries.length === 0 && (
        <p className="card-empty">{t("activity.empty")}</p>
      )}
      {entries !== undefined && entries.length > 0 && (
        <div className="table-scroll">
          <table className="activity-table">
            <thead>
              <tr>
                <th scope="col">{t("activity.time")}</th>
                <th scope="col">{t("activity.event")}</th>
                <th scope="col">{t("activity.address")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.at)}</td>
                  <td>{label(entry)}</td>
                  <td dir="ltr" className="activity-address">
                    {entry.ipAddress ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The signed-in admin page: passkeys, password, and recent security activity. */
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
        <PasswordSection />
        <ActivitySection onSessionLost={onSessionLost} />
      </div>
    </div>
  );
}
