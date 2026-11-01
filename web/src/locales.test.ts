import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import he from "./locales/he.json";
import { flatten } from "./testing/flatten";

describe("locale files", () => {
  const hebrew = flatten(he);
  const english = flatten(en);

  it("have the same keys", () => {
    expect([...hebrew.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("have no empty strings", () => {
    for (const [key, value] of [...hebrew, ...english]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("write Hebrew in the Hebrew file and no Hebrew in the English file", () => {
    // Code points, not a regex literal: formatters may turn \u escapes into
    // literal Hebrew letters, which the repository's Hebrew guard rejects here.
    const hasHebrew = (text: string) =>
      [...text].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 0x0590 && code <= 0x05ff;
      });
    expect(hasHebrew(he.home.heading)).toBe(true);
    for (const [key, value] of english) {
      expect(hasHebrew(value), key).toBe(false);
    }
  });
});
