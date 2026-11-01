import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/http/request-guards.js";

describe("normalizeAddress", () => {
  it.each([
    ["::ffff:172.23.0.1", "172.23.0.1"],
    ["::FFFF:198.51.100.7", "198.51.100.7"],
    ["198.51.100.7", "198.51.100.7"],
    ["2001:db8::1", "2001:db8::1"],
    ["::1", "::1"],
    ["", undefined],
    [undefined, undefined],
  ])("%s becomes %s", (input, output) => {
    expect(normalizeAddress(input)).toBe(output);
  });
});
