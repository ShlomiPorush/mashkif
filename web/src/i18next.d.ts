import "i18next";
import type en from "./locales/en.json";

// Translation keys are checked at compile time against the English locale.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
