import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, ENV_EXAMPLE_PLACEHOLDER, loadConfig } from "../src/config.js";
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

describe("DATABASE_URL password", () => {
  const refused =
    /DATABASE_URL needs a database password other than the \.env\.example placeholder/;

  it.each([
    [
      "the .env.example placeholder",
      `postgres://mashkif:${ENV_EXAMPLE_PLACEHOLDER}@db:5432/mashkif`,
    ],
    ["the encoded placeholder", "postgres://mashkif:change%2Dme@db:5432/mashkif"],
    [
      "the placeholder with several hosts",
      "postgres://mashkif:change-me@db1:5432,db2:5432/mashkif",
    ],
    ["an empty password", "postgres://mashkif:@db:5432/mashkif"],
    ["no password", "postgres://mashkif@db:5432/mashkif"],
    ["no userinfo", "postgres://db:5432/mashkif?application_name=a:b@c"],
  ])("refuses %s without quoting the URL", (_name, url) => {
    try {
      loadConfig({ ...valid, DATABASE_URL: url });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(refused);
      expect(String(error)).not.toContain("postgres://");
      expect(String(error)).not.toContain("mashkif:");
    }
  });

  // The check must see the password that postgres.js sends. Each URL is also
  // given to the driver itself, which parses it without connecting, so a
  // change in the driver's parsing fails here.
  const random = randomBytes(32).toString("hex");
  it.each([
    ["one host", `postgres://mashkif:${random}@db:5432/mashkif`, "accepted"],
    ["several hosts", `postgres://mashkif:${random}@db1:5432,db2:5432/mashkif`, "accepted"],
    // postgres.js 3.4.9 itself throws Invalid URL for an empty host, so the
    // server cannot start with this form either way.
    [
      "a Unix socket and an empty host",
      `postgres://mashkif:${random}@/mashkif?host=/var/run/postgresql`,
      "unreadable",
    ],
    [
      "a percent-encoded socket host",
      `postgres://mashkif:${random}@%2Frun%2Fpg/mashkif`,
      "accepted",
    ],
    ["IPv6", `postgresql://mashkif:${random}@[::1]:5432/mashkif`, "accepted"],
    ["sslmode", `postgres://mashkif:${random}@db:5432/mashkif?sslmode=require`, "accepted"],
    ["percent-encoded / @ :", `postgres://mashkif:${random}%2F%40%3A@db:5432/mashkif`, "accepted"],
    [
      "an unencoded @ after the placeholder",
      `postgres://mashkif:change-me@${random}@db/mashkif`,
      "accepted",
    ],
    [
      "an unencoded @ before the placeholder",
      `postgres://mashkif:${random}@change-me@db/mashkif`,
      "accepted",
    ],
    [
      "a TAB inside a random password",
      `postgres://mashkif:${random}\t${random}@db/mashkif`,
      "accepted",
    ],
    ["a TAB inside the placeholder", "postgres://mashkif:change-\tme@db/mashkif", "refused"],
    ["a newline inside the placeholder", "postgres://mashkif:change-\nme@db/mashkif", "refused"],
    [
      "a carriage return inside the placeholder",
      "postgres://mashkif:chan\rge-me@db/mashkif",
      "refused",
    ],
    ["a leading control character", "\u0001postgres://mashkif:change-me@db/mashkif", "refused"],
    ["a trailing control character", "postgres://mashkif:change-me@db/mashkif\u001f", "refused"],
  ])("with %s, matches the driver's own parsing", async (_name, url, expected) => {
    const config = () => loadConfig({ ...valid, DATABASE_URL: url });
    if (expected === "unreadable") {
      expect(() => postgres(url)).toThrow();
      expect(config).toThrow(/DATABASE_URL is not a URL the PostgreSQL client can read/);
      return;
    }
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const driverPassword = (sql.options as unknown as { pass: string }).pass;
    await sql.end({ timeout: 0 });
    if (expected === "refused") {
      expect(driverPassword).toBe(ENV_EXAMPLE_PLACEHOLDER);
      expect(config).toThrow(ConfigError);
    } else {
      expect(driverPassword).not.toBe(ENV_EXAMPLE_PLACEHOLDER);
      expect(driverPassword.length).toBeGreaterThan(0);
      expect(config().databaseUrl).toBe(url);
    }
  });

  it("refuses a URL the driver cannot read without quoting the password", () => {
    const password = randomBytes(16).toString("hex");
    try {
      loadConfig({ ...valid, DATABASE_URL: `postgres://mashkif:${password}%zz@db:5432/mashkif` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/DATABASE_URL is not a URL the PostgreSQL client can read/);
      expect(String(error)).not.toContain(password);
    }
  });

  it("matches the placeholder of every secret in .env.example", () => {
    const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const value = (name: string) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
    expect(value("POSTGRES_PASSWORD")).toBe(ENV_EXAMPLE_PLACEHOLDER);
    expect(new URL(value("DATABASE_URL") ?? "").password).toBe(ENV_EXAMPLE_PLACEHOLDER);
    expect(value("BETTER_AUTH_SECRET")).toBe(ENV_EXAMPLE_PLACEHOLDER);
    expect(() => loadConfig({ ...valid, DATABASE_URL: value("DATABASE_URL") })).toThrow(refused);
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
