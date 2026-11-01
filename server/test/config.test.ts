import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://mashkif:example@db:5432/mashkif",
  MASHKIF_GEOIP_ASN_PATH: "/geoip/GeoLite2-ASN.mmdb",
};

describe("loadConfig", () => {
  it("reads the settings and defaults PORT to 8080", () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      geoipAsnPath: valid.MASHKIF_GEOIP_ASN_PATH,
      port: DEFAULT_PORT,
    });
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("accepts an explicit port", () => {
    expect(loadConfig({ ...valid, PORT: "3000" }).port).toBe(3000);
  });

  it("names every missing setting", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL is required.*MASHKIF_GEOIP_ASN_PATH is required/,
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
