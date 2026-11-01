import type { Resource } from "i18next";
import { expect } from "vitest";
import type { Language } from "../i18n";
import en from "../locales/en.json";
import { flatten } from "./flatten";

/** Every locale value replaced by its key in markers, for both languages. */
export function pseudoResources(): Resource {
  const tree: Record<string, Record<string, string>> = {};
  for (const [key] of flatten(en)) {
    const [group, name] = key.split(".") as [string, string];
    tree[group] = { ...tree[group], [name]: `[[${key}]]` };
  }
  const languages: Language[] = ["he", "en"];
  return Object.fromEntries(languages.map((language) => [language, { translation: tree }]));
}

const MARKER = /^\[\[[a-zA-Z]+\.[a-zA-Z]+\]\]$/;

/**
 * Asserts that every visible text and every text attribute in the container
 * comes from the locale files. Render with pseudoResources() first.
 */
export function expectOnlyLocaleText(container: HTMLElement): void {
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
    expect(text).toMatch(MARKER);
  }
  for (const attribute of ["aria-label", "title", "alt", "placeholder"]) {
    for (const element of container.querySelectorAll(`[${attribute}]`)) {
      expect(element.getAttribute(attribute)).toMatch(MARKER);
    }
  }
}
