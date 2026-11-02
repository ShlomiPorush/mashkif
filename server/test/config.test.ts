import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, loadConfig } from "../src/config.js";
import { parsePublicUrl } from "../src/settings.js";

const secret = randomBytes(32).toString("base64");

const valid = {
  DATABASE_URL: "postgres://mashkif:example@db:5432/mashkif",
  MASHKIF_GEOIP_ASN_PATH: "/geoip/GeoLite2-ASN.mmdb",
  BETTER_AUTH_SECRET: secret,
};

describe("loadConfig", () => {
  it("reads the environment-only values and defaults PORT to 8080", () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      geoipAsnPath: valid.MASHKIF_GEOIP_ASN_PATH,
      port: DEFAULT_PORT,
      authSecret: secret,
    });
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("accepts an explicit port", () => {
    expect(loadConfig({ ...valid, PORT: "3000" }).port).toBe(3000);
  });

  it("names every missing value", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL is required.*MASHKIF_GEOIP_ASN_PATH is required.*BETTER_AUTH_SECRET is required/,
    );
  });

  it("needs no public URL: Better Auth then infers it from each request", () => {
    expect(() => loadConfig(valid)).not.toThrow();
  });

  it("rejects a database URL that is not PostgreSQL", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://db/x" })).toThrow(/postgres:\/\//);
  });

  it.each(["0", "65536", "80a", "-1", "8080.5"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(/PORT must be/);
  });

  it("never puts the database URL in the error message", () => {
    const leaked = "postgres://mashkif:s3cret@db/mashkif";
    try {
      loadConfig({ DATABASE_URL: leaked, PORT: "x" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cret");
    }
  });
});

describe("BETTER_AUTH_SECRET", () => {
  it("rejects the .env.example placeholder and short values without quoting them", () => {
    for (const value of ["change-me", "x".repeat(31)]) {
      try {
        loadConfig({ ...valid, BETTER_AUTH_SECRET: value });
        expect.unreachable();
      } catch (error) {
        expect(String(error)).toMatch(/BETTER_AUTH_SECRET must be at least 32 random characters/);
        expect(String(error)).not.toContain(value);
      }
    }
  });

  it("is passed on as is, without derivation", () => {
    expect(loadConfig({ ...valid, BETTER_AUTH_SECRET: ` ${secret} ` }).authSecret).toBe(secret);
  });
});

describe("environment overrides of settings", () => {
  it("are validated at startup", () => {
    expect(() =>
      loadConfig({
        ...valid,
        BETTER_AUTH_URL: "http://mashkif.co.il",
        MASHKIF_TRUSTED_PROXIES: "172.18.0.0/16,traefik",
        MASHKIF_SESSION_HOURS: "twelve",
        MASHKIF_SMTP_PORT: "70000",
      }),
    ).toThrow(
      /BETTER_AUTH_URL is not a valid value.*MASHKIF_TRUSTED_PROXIES is not a valid value.*MASHKIF_SESSION_HOURS is not a valid value.*MASHKIF_SMTP_PORT is not a valid value/,
    );
  });

  it("accept valid values, and an empty variable sets nothing", () => {
    expect(() =>
      loadConfig({
        ...valid,
        BETTER_AUTH_URL: "https://mashkif.co.il",
        MASHKIF_TRUSTED_PROXIES: "",
        MASHKIF_SESSION_HOURS: "24",
        MASHKIF_SMTP_PORT: "587",
      }),
    ).not.toThrow();
  });
});

describe("parsePublicUrl", () => {
  it.each([
    ["https://mashkif.co.il", "https://mashkif.co.il"],
    ["https://mashkif.co.il/", "https://mashkif.co.il"],
    ["https://mashkif.co.il:8443", "https://mashkif.co.il:8443"],
    ["http://127.0.0.1:8180", "http://127.0.0.1:8180"],
    ["http://localhost:8180", "http://localhost:8180"],
    ["http://[::1]:8180", "http://[::1]:8180"],
  ])("accepts %s", (value, origin) => {
    expect(parsePublicUrl(value)).toBe(origin);
  });

  it.each([
    "http://mashkif.co.il",
    "https://mashkif.co.il/admin",
    "https://mashkif.co.il/?x=1",
    "https://user:pass@mashkif.co.il",
    "mashkif.co.il",
    "ftp://mashkif.co.il",
  ])("rejects %s", (value) => {
    expect(parsePublicUrl(value)).toBeUndefined();
  });
});
