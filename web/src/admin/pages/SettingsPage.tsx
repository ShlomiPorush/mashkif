import { type InputHTMLAttributes, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AdminSettings, adminApi } from "../api";
import { Button, Field, Notice } from "../components";
import { ManagePage, useAdminResource, useDateFormat } from "../manage";

type Name =
  | "heartbeatIntervalSeconds"
  | "retentionDays"
  | "publicUrl"
  | "trustedOrigins"
  | "trustedProxies"
  | "sessionHours"
  | "smtpHost"
  | "smtpPort"
  | "smtpUser"
  | "smtpPassword"
  | "smtpFrom";

type Kind = "number" | "text" | "list" | "password";

interface FieldSpec {
  name: Name;
  kind: Kind;
  input?: InputHTMLAttributes<HTMLInputElement>;
}

const GROUPS: {
  heading: "settings.agentsGroup" | "settings.signInGroup" | "settings.mailGroup";
  fields: FieldSpec[];
}[] = [
  {
    heading: "settings.agentsGroup",
    fields: [
      { name: "heartbeatIntervalSeconds", kind: "number", input: { min: 30, max: 600 } },
      { name: "retentionDays", kind: "number", input: { min: 8, max: 3650 } },
    ],
  },
  {
    heading: "settings.signInGroup",
    fields: [
      { name: "publicUrl", kind: "text", input: { type: "url", dir: "ltr" } },
      { name: "trustedOrigins", kind: "list", input: { dir: "ltr" } },
      { name: "trustedProxies", kind: "list", input: { dir: "ltr" } },
      { name: "sessionHours", kind: "number", input: { min: 1, max: 168 } },
    ],
  },
  {
    heading: "settings.mailGroup",
    fields: [
      { name: "smtpHost", kind: "text", input: { dir: "ltr" } },
      { name: "smtpPort", kind: "number", input: { min: 1, max: 65535 } },
      { name: "smtpUser", kind: "text", input: { dir: "ltr", autoComplete: "off" } },
      { name: "smtpPassword", kind: "password", input: { autoComplete: "new-password" } },
      { name: "smtpFrom", kind: "text", input: { type: "email", dir: "ltr" } },
    ],
  },
];

const INPUT_TYPES: Partial<Record<Kind, string>> = { number: "number", password: "password" };

const APPLY_KEYS = {
  now: "settings.applyNow",
  restart: "settings.applyRestart",
  next_email: "settings.applyNextEmail",
} as const;

function shown(data: AdminSettings, field: FieldSpec): string | number {
  if (field.kind === "password") {
    return "";
  }
  const value = data[field.name as Exclude<Name, "smtpPassword">];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** The value to send for one field, or undefined to leave the setting unchanged. */
function toSend(field: FieldSpec, text: string): unknown {
  switch (field.kind) {
    case "number":
      return Number(text);
    case "list":
      return text
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    case "password":
      // An empty field keeps the stored password.
      return text === "" ? undefined : text;
    default:
      return text.trim();
  }
}

/** Every setting, with the environment overrides locked, and the GeoLite2-ASN status. */
export function SettingsPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const { data, error, busy, act } = useAdminResource<AdminSettings>("/settings", onSessionLost);
  const [saved, setSaved] = useState(false);
  const geoip = data?.geoip;

  let geoipText: string | undefined;
  if (geoip !== undefined) {
    if (geoip.state !== "ok" || geoip.buildDate === null) {
      geoipText = t("settings.geoipUnavailable");
    } else {
      const date = formatDate(geoip.buildDate);
      geoipText = geoip.stale
        ? t("settings.geoipStale", { date })
        : t("settings.geoipOk", { date });
    }
  }

  /** The help of a field: its own text, when it applies, and why it is locked; one locale string each. */
  const help = (current: AdminSettings, field: FieldSpec): ReactNode => {
    const parts = [t(`settings.${field.name}Help`)];
    if (field.name === "sessionHours") {
      parts.push(t("settings.applySessions"));
    } else {
      const apply = current.apply[field.name];
      if (apply !== undefined) {
        parts.push(t(APPLY_KEYS[apply]));
      }
    }
    if (field.kind === "password") {
      parts.push(
        current.smtpPasswordSet ? t("settings.passwordSet") : t("settings.passwordNotSet"),
      );
    }
    if (current.locked.includes(field.name)) {
      parts.push(t("settings.locked", { variable: current.env[field.name] ?? "" }));
    }
    return parts.map((part, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of sentences.
      <span key={index}>
        {index > 0 ? " " : null}
        {part}
      </span>
    ));
  };

  return (
    <ManagePage heading={t("settings.heading")} intro={t("settings.intro")}>
      {data !== undefined && (
        <form
          className="manage-page"
          onSubmit={(event) => {
            event.preventDefault();
            const element = event.currentTarget;
            const form = new FormData(element);
            const body: Record<string, unknown> = {};
            for (const field of GROUPS.flatMap((group) => group.fields)) {
              if (data.locked.includes(field.name)) {
                continue;
              }
              const value = toSend(field, String(form.get(field.name) ?? ""));
              if (value !== undefined) {
                body[field.name] = value;
              }
            }
            setSaved(false);
            void act(() => adminApi.post("/settings", body)).then((ok) => {
              setSaved(ok);
              // A saved password is not kept in the page.
              const password = element.elements.namedItem("smtpPassword");
              if (ok && password instanceof HTMLInputElement) {
                password.value = "";
              }
            });
          }}
        >
          {GROUPS.map((group) => (
            <section key={group.heading} className="admin-card">
              <h2 className="card-heading">{t(group.heading)}</h2>
              <div className="form">
                {group.fields.map((field) => {
                  const locked = data.locked.includes(field.name);
                  return (
                    <Field
                      key={field.name}
                      label={t(`settings.${field.name}`)}
                      help={help(data, field)}
                      name={field.name}
                      {...field.input}
                      type={INPUT_TYPES[field.kind] ?? field.input?.type ?? "text"}
                      {...(field.kind === "number" ? { inputMode: "numeric", step: 1 } : {})}
                      required={field.kind === "number"}
                      readOnly={locked}
                      aria-readonly={locked}
                      defaultValue={shown(data, field)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          <Notice error={error}>{saved ? t("settings.saved") : undefined}</Notice>
          <Button busy={busy}>{t("settings.save")}</Button>
        </form>
      )}
      {data === undefined && <Notice error={error} />}
      {geoipText !== undefined && (
        <section className="admin-card" aria-labelledby="geoip-heading">
          <h2 id="geoip-heading" className="card-heading">
            {t("settings.geoip")}
          </h2>
          <p
            className={geoip?.stale || geoip?.state !== "ok" ? "notice notice-error" : "card-intro"}
          >
            {geoipText}
          </p>
        </section>
      )}
    </ManagePage>
  );
}
