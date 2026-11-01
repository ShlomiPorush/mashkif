import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, loadConfig } from "../src/config.js";

const appKey = randomBytes(32);

const valid = {
  DATABASE_URL: "postgres://mashkif:example@db:5432/mashkif",
  MASHKIF_GEOIP_ASN_PATH: "/geoip/GeoLite2-ASN.mmdb",
  MASHKIF_APP_KEY: appKey.toString("base64"),
  MASHKIF_PUBLIC_URL: "https://mashkif.co.il",
};

describe("loadConfig", () => {
  it("reads the settings and defaults PORT to 8080", () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      geoipAsnPath: valid.MASHKIF_GEOIP_ASN_PATH,
      port: DEFAULT_PORT,
      appKey,
      publicOrigin: "https://mashkif.co.il",
    });
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("accepts an explicit port", () => {
    expect(loadConfig({ ...valid, PORT: "3000" }).port).toBe(3000);
  });

  it("names every missing setting", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL is required.*MASHKIF_GEOIP_ASN_PATH is required.*MASHKIF_APP_KEY is required.*MASHKIF_PUBLIC_URL is required/,
    );
  });

  it("rejects a database URL that is not PostgreSQL", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://db/x" })).toThrow(/postgres:\/\//);
  });

  it.each(["0", "65536", "80a", "-1", "8080.5"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(/PORT must be/);
  });

  it("never puts the database URL in the error message", () => {
    const secret = "postgres://mashkif:s3cret@db/mashkif";
    try {
      loadConfig({ DATABASE_URL: secret, PORT: "x" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cret");
    }
  });
});

describe("MASHKIF_APP_KEY", () => {
  it("accepts 32 or more random bytes in base64 or base64url", () => {
    const longer = randomBytes(48);
    expect(loadConfig({ ...valid, MASHKIF_APP_KEY: longer.toString("base64url") }).appKey).toEqual(
      longer,
    );
    expect(loadConfig({ ...valid, MASHKIF_APP_KEY: ` ${valid.MASHKIF_APP_KEY} ` }).appKey).toEqual(
      appKey,
    );
  });

  it.each([
    ["the .env.example placeholder", "change-me"],
    ["31 bytes", randomBytes(31).toString("base64")],
    ["text that is not base64", "this is not a key, it has spaces!"],
    ["32 repeated bytes", Buffer.alloc(32, 7).toString("base64")],
  ])("rejects %s with a clear message", (_, value) => {
    expect(() => loadConfig({ ...valid, MASHKIF_APP_KEY: value })).toThrow(
      /MASHKIF_APP_KEY must be at least 32 random bytes in base64 \(generate one with: openssl rand -base64 32\)/,
    );
  });

  it("is required", () => {
    expect(() => loadConfig({ ...valid, MASHKIF_APP_KEY: " " })).toThrow(
      /MASHKIF_APP_KEY is required/,
    );
  });

  it("never puts the key in the error message", () => {
    const leaked = randomBytes(20).toString("base64");
    try {
      loadConfig({ ...valid, MASHKIF_APP_KEY: leaked });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });
});

describe("MASHKIF_PUBLIC_URL", () => {
  it.each([
    ["https://mashkif.co.il", "https://mashkif.co.il"],
    ["https://mashkif.co.il/", "https://mashkif.co.il"],
    ["https://mashkif.co.il:8443", "https://mashkif.co.il:8443"],
    ["http://127.0.0.1:8180", "http://127.0.0.1:8180"],
    ["http://localhost:8180", "http://localhost:8180"],
    ["http://[::1]:8180", "http://[::1]:8180"],
  ])("accepts %s", (value, origin) => {
    expect(loadConfig({ ...valid, MASHKIF_PUBLIC_URL: value }).publicOrigin).toBe(origin);
  });

  it.each([
    "http://mashkif.co.il",
    "https://mashkif.co.il/admin",
    "https://mashkif.co.il/?x=1",
    "https://user:pass@mashkif.co.il",
    "mashkif.co.il",
    "ftp://mashkif.co.il",
  ])("rejects %s", (value) => {
    expect(() => loadConfig({ ...valid, MASHKIF_PUBLIC_URL: value })).toThrow(
      /MASHKIF_PUBLIC_URL must be an https:\/\/ origin without a path/,
    );
  });
});
