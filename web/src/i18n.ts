import i18next, { type i18n as I18n, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import he from "./locales/he.json";

export const LANGUAGES = ["he", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Hebrew is the default language; English is the second language. */
export const DEFAULT_LANGUAGE: Language = "he";

const LANGUAGE_STORAGE_KEY = "mashkif.language";

export const resources = {
  he: { translation: he },
  en: { translation: en },
} as const satisfies Resource;

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

export function directionOf(language: Language): "rtl" | "ltr" {
  return language === "he" ? "rtl" : "ltr";
}

/** The language other than the given one, offered by the language switch. */
export function otherLanguage(language: Language): Language {
  return language === "he" ? "en" : "he";
}

/** The saved language, or Hebrew when nothing valid is saved. */
export function readLanguagePreference(): Language {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(saved) ? saved : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function saveLanguagePreference(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The choice
    // then lasts for this page view only.
  }
}

/** The current language of an i18n instance, falling back to the default. */
export function currentLanguage(instance: I18n): Language {
  return isLanguage(instance.language) ? instance.language : DEFAULT_LANGUAGE;
}

/** Sets <html lang dir> and the document title from the instance's language. */
export function applyDocumentLanguage(instance: I18n): void {
  const language = currentLanguage(instance);
  const root = document.documentElement;
  root.lang = language;
  root.dir = directionOf(language);
  document.title = instance.t("app.tagline");
}

/**
 * Creates an initialised i18n instance. The locale files are bundled, so
 * initialisation is synchronous. `source` lets tests replace the strings.
 */
export function createI18n(language: Language, source: Resource = resources): I18n {
  const instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    resources: source,
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

/** Keeps <html lang dir>, the title, and the saved preference in step with the language. */
export function bindDocumentLanguage(instance: I18n): void {
  applyDocumentLanguage(instance);
  instance.on("languageChanged", () => {
    applyDocumentLanguage(instance);
    saveLanguagePreference(currentLanguage(instance));
  });
}
