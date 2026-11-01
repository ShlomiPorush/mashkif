import "@fontsource-variable/rubik/wght.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App";
import { bindDocumentLanguage, createI18n, readLanguagePreference } from "./i18n";
import { applyThemePreference, readThemePreference } from "./theme";

applyThemePreference(readThemePreference());
const i18n = createI18n(readLanguagePreference());
bindDocumentLanguage(i18n);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </StrictMode>,
);
