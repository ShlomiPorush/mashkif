import { useTranslation } from "react-i18next";
import { currentLanguage, otherLanguage } from "../i18n";

/** Switches between Hebrew and English. The target language is named in its own language. */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const target = otherLanguage(currentLanguage(i18n));
  const targetName = i18n.getFixedT(target)("language.name");

  return (
    <button
      type="button"
      className="language-switch"
      onClick={() => {
        void i18n.changeLanguage(target);
      }}
    >
      <span className="visually-hidden">{t("language.switch")}</span>{" "}
      <span lang={target}>{targetName}</span>
    </button>
  );
}
