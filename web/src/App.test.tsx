import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { i18n as I18n, Resource } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { bindDocumentLanguage, createI18n, type Language, readLanguagePreference } from "./i18n";
import en from "./locales/en.json";
import he from "./locales/he.json";
import { flatten } from "./testing/flatten";
import { applyThemePreference, readThemePreference } from "./theme";

function renderApp(instance: I18n) {
  bindDocumentLanguage(instance);
  applyThemePreference(readThemePreference());
  return render(
    <I18nextProvider i18n={instance}>
      <App />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
});

describe("language", () => {
  it("defaults to Hebrew, right to left", () => {
    expect(readLanguagePreference()).toBe("he");
    renderApp(createI18n(readLanguagePreference()));
    expect(document.documentElement.lang).toBe("he");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.title).toBe(he.app.tagline);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(he.home.heading);
    expect(screen.getByText(he.home.privacy)).toBeTruthy();
  });

  it("switches to English, left to right, and remembers the choice", async () => {
    renderApp(createI18n("he"));
    const button = screen.getByRole("button", {
      name: `${he.language.switch} ${en.language.name}`,
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe(en.app.tagline);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en.home.heading);
    expect(readLanguagePreference()).toBe("en");
    expect(
      screen.getByRole("button", { name: `${en.language.switch} ${he.language.name}` }),
    ).toBeTruthy();
  });

  it("ignores an unknown saved language", () => {
    window.localStorage.setItem("mashkif.language", "fr");
    expect(readLanguagePreference()).toBe("he");
  });
});

describe("theme", () => {
  it("follows the device until the user picks a theme", () => {
    renderApp(createI18n("en"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const system = screen.getByRole("radio", { name: en.theme.system }) as HTMLInputElement;
    expect(system.checked).toBe(true);
  });

  it("pins dark and light, and returns to the device setting", () => {
    renderApp(createI18n("en"));
    fireEvent.click(screen.getByRole("radio", { name: en.theme.dark }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readThemePreference()).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: en.theme.light }));
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(screen.getByRole("radio", { name: en.theme.system }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(readThemePreference()).toBe("system");
  });

  it("restores a saved theme", () => {
    window.localStorage.setItem("mashkif.theme", "dark");
    renderApp(createI18n("he"));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("user-facing text", () => {
  /** Every value replaced by its key in markers, for both languages. */
  function pseudoResources(): Resource {
    const tree: Record<string, Record<string, string>> = {};
    for (const [key] of flatten(en)) {
      const [group, name] = key.split(".") as [string, string];
      tree[group] = { ...tree[group], [name]: `[[${key}]]` };
    }
    const languages: Language[] = ["he", "en"];
    return Object.fromEntries(languages.map((language) => [language, { translation: tree }]));
  }

  it("comes only from the locale files", () => {
    const { container } = renderApp(createI18n("he", pseudoResources()));
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (text !== "") {
        texts.push(text);
      }
    }
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).toMatch(/^\[\[[a-z]+\.[a-zA-Z]+\]\]$/);
    }
    for (const attribute of ["aria-label", "title", "alt", "placeholder"]) {
      for (const element of container.querySelectorAll(`[${attribute}]`)) {
        expect(element.getAttribute(attribute)).toMatch(/^\[\[[a-z]+\.[a-zA-Z]+\]\]$/);
      }
    }
  });
});
