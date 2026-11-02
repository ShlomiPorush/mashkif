import { useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi, type EnrollmentKeySummary } from "../api";
import { Button, Field, Notice } from "../components";
import { ManagePage, useAdminResource, useDateFormat, Value } from "../manage";

const VALIDITY_HOURS = [1, 24, 72, 168] as const;

const STATUS_KEYS = {
  active: "keys.statusActive",
  used: "keys.statusUsed",
  expired: "keys.statusExpired",
  revoked: "keys.statusRevoked",
} as const;

/** A key just created: shown once, with a copy button. */
function NewKey({
  created,
  onDone,
}: {
  created: { secret: string; key: EnrollmentKeySummary };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const [copied, setCopied] = useState(false);
  return (
    <section className="admin-card new-key" aria-labelledby="new-key-heading">
      <h2 id="new-key-heading" className="card-heading">
        {t("keys.newKey", { label: created.key.label })}
      </h2>
      <code className="secret" dir="ltr" data-value="">
        {created.secret}
      </code>
      <p className="card-intro">
        {t("keys.shownOnce", { date: formatDate(created.key.expiresAt) })}
      </p>
      <div className="button-row">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(created.secret)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {t("keys.copy")}
        </Button>
        <Button type="button" variant="quiet" onClick={onDone}>
          {t("keys.done")}
        </Button>
      </div>
      {copied && <Notice>{t("keys.copied")}</Notice>}
    </section>
  );
}

/** Creating, listing, and revoking single-use enrollment keys. */
export function KeysPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const { data, error, busy, act } = useAdminResource<{ keys: EnrollmentKeySummary[] }>(
    "/enrollment-keys",
    onSessionLost,
  );
  const [created, setCreated] = useState<{ secret: string; key: EnrollmentKeySummary }>();

  return (
    <ManagePage heading={t("keys.heading")} intro={t("keys.intro")}>
      {created !== undefined && <NewKey created={created} onDone={() => setCreated(undefined)} />}
      <section className="admin-card" aria-labelledby="create-key-heading">
        <h2 id="create-key-heading" className="card-heading">
          {t("keys.create")}
        </h2>
        <form
          className="form form-split"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            void act(async () => {
              const answer = await adminApi.post<{ secret: string; key: EnrollmentKeySummary }>(
                "/enrollment-keys",
                {
                  label: String(fields.get("label")).trim(),
                  validHours: Number(fields.get("validHours")),
                },
              );
              setCreated(answer);
              form.reset();
            });
          }}
        >
          <Field
            label={t("keys.label")}
            help={t("keys.labelHelp")}
            name="label"
            maxLength={100}
            required
            autoComplete="off"
          />
          <div className="field">
            <label className="field-label" htmlFor="key-validity">
              {t("keys.validity")}
            </label>
            <select id="key-validity" className="field-input" name="validHours" defaultValue="24">
              {VALIDITY_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {t(`keys.hours${hours}`)}
                </option>
              ))}
            </select>
          </div>
          <Button busy={busy}>{t("keys.create")}</Button>
        </form>
      </section>
      <Notice error={error} />
      {data !== undefined && data.keys.length === 0 && (
        <p className="card-empty">{t("keys.empty")}</p>
      )}
      {data !== undefined && data.keys.length > 0 && (
        <ul className="row-list">
          {data.keys.map((key) => (
            <li key={key.id} className="row-item">
              <div className="row-main">
                <p className="row-title">
                  <Value>{key.label}</Value>
                  <span className={`badge badge-key-${key.status}`}>
                    {t(STATUS_KEYS[key.status])}
                  </span>
                </p>
                <p className="field-help meta">
                  <span>{t("keys.created", { date: formatDate(key.createdAt) })}</span>
                  <span>
                    {key.status === "used" && key.usedAt !== null
                      ? t("keys.used", { date: formatDate(key.usedAt) })
                      : key.status === "expired"
                        ? t("keys.expired", { date: formatDate(key.expiresAt) })
                        : t("keys.expires", { date: formatDate(key.expiresAt) })}
                  </span>
                </p>
              </div>
              {key.status === "active" && (
                <Button
                  type="button"
                  variant="quiet"
                  busy={busy}
                  onClick={() => void act(() => adminApi.post(`/enrollment-keys/${key.id}/revoke`))}
                >
                  {t("keys.revoke")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </ManagePage>
  );
}
