import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from "../theme";

const ICONS: Record<ThemePreference, ReactNode> = {
  system: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" className="icon-fill" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
    </svg>
  ),
};

/** Chooses between following the device setting, light, and dark. */
export function ThemeSwitch() {
  const { t } = useTranslation();
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    applyThemePreference(next);
    saveThemePreference(next);
  };

  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">{t("theme.label")}</legend>
      {THEME_PREFERENCES.map((option) => (
        <label key={option} className="theme-option" title={t(`theme.${option}`)}>
          <input
            type="radio"
            name="theme"
            value={option}
            checked={preference === option}
            onChange={() => choose(option)}
            className="visually-hidden"
          />
          {ICONS[option]}
          <span className="visually-hidden">{t(`theme.${option}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}
