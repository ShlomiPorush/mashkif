import { useTranslation } from "react-i18next";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { ThemeSwitch } from "./components/ThemeSwitch";

/** Concentric rings around a point: a signal going out. Decorative only. */
function Signal() {
  return (
    <svg className="signal" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <circle className="signal-ring" cx="100" cy="100" r="96" />
      <circle className="signal-ring" cx="100" cy="100" r="70" />
      <circle className="signal-ring" cx="100" cy="100" r="44" />
      <circle className="signal-core" cx="100" cy="100" r="16" />
    </svg>
  );
}

export function App() {
  const { t } = useTranslation();

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <a className="brand-name" href="/">
            {t("app.name")}
          </a>
          <p className="brand-tagline">{t("app.tagline")}</p>
        </div>
        <div className="controls">
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </header>
      <main className="main">
        <section className="hero">
          <div className="hero-text">
            <h1 className="hero-heading">{t("home.heading")}</h1>
            <p className="hero-privacy">{t("home.privacy")}</p>
          </div>
          <Signal />
        </section>
      </main>
    </div>
  );
}
