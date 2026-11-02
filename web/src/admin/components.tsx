import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  useId,
} from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { ThemeSwitch } from "../components/ThemeSwitch";
import type { ErrorKey } from "./errors";

/** The admin header and page area. */
export function AdminFrame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="shell admin">
      <header className="header">
        <div className="brand admin-brand">
          <a className="brand-name" href="/">
            {t("app.name")}
          </a>
          <span className="admin-badge">{t("admin.title")}</span>
        </div>
        <div className="controls">
          {actions}
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}

/** A centered panel for the sign-in, setup, and TOTP steps. */
export function AuthPanel({
  heading,
  intro,
  children,
}: {
  heading: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="auth-panel" aria-labelledby="auth-heading">
      <h1 id="auth-heading" className="auth-heading">
        {heading}
      </h1>
      {intro !== undefined && <p className="auth-intro">{intro}</p>}
      {children}
    </section>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Field({ label, help, ...input }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field-input"
        {...(help === undefined ? {} : { "aria-describedby": helpId })}
        {...input}
      />
      {help !== undefined && (
        <p id={helpId} className="field-help">
          {help}
        </p>
      )}
    </div>
  );
}

/** An error or status line, announced to screen readers. */
export function Notice({
  error,
  children,
}: {
  error?: ErrorKey | undefined;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  if (error === undefined && children === undefined) {
    return null;
  }
  return (
    <p
      className={error === undefined ? "notice" : "notice notice-error"}
      role={error ? "alert" : "status"}
    >
      {error === undefined ? children : t(error)}
    </p>
  );
}

export function Button({
  busy,
  variant = "primary",
  children,
  ...button
}: {
  busy?: boolean;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { t } = useTranslation();
  return (
    <button
      type="submit"
      {...button}
      className={`button button-${variant}`}
      disabled={busy === true || button.disabled === true}
      aria-busy={busy === true}
    >
      {busy === true ? t("admin.working") : children}
    </button>
  );
}

/** TOTP backup codes, shown once: when TOTP is enrolled and when they are generated again. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className="backup-codes" aria-labelledby={headingId}>
      <h2 id={headingId} className="card-heading">
        {t("backupCodes.heading")}
      </h2>
      <p className="field-help">{t("backupCodes.help")}</p>
      <ul className="backup-code-list" dir="ltr">
        {codes.map((code) => (
          <li key={code}>
            {/* User data, never translated. */}
            <span data-value="">{code}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
