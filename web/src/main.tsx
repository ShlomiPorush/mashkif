import "@fontsource-variable/rubik/wght.css";
import "./styles.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App";
import { bindDocumentLanguage, createI18n, readLanguagePreference } from "./i18n";
import { applyThemePreference, readThemePreference } from "./theme";

// The admin panel is a separate chunk: the public pages never load its code.
const AdminApp = lazy(() =>
  import("./admin/AdminApp").then((module) => ({ default: module.AdminApp })),
);

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

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
      {isAdminPath(window.location.pathname) ? (
        <Suspense fallback={null}>
          <AdminApp />
        </Suspense>
      ) : (
        <App />
      )}
    </I18nextProvider>
  </StrictMode>,
);
