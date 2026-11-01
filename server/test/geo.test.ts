import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latLngToCell } from "h3-js";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAreaCell } from "../src/geo/area.js";
import { inServiceArea } from "../src/geo/service-area.js";
import { siteKeyOf } from "../src/geo/site.js";
import { GeoLiteAsn } from "../src/geoip.js";
import { clientAddressResolver, parseTrustedProxies } from "../src/http/client-address.js";
import { writeAsnDatabase } from "./support/mmdb.js";

describe("site of an address", () => {
  it.each([
    ["198.51.100.7", "198.51.100.7"],
    ["2001:db8:1:2::10", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::198.51.100.7", "64:ff9b:0:0::/64"],
  ])("%s is site %s", (address, site) => {
    expect(siteKeyOf(address)).toBe(site);
  });

  it("is undefined for anything else", () => {
    expect(siteKeyOf("example.com")).toBeUndefined();
    expect(siteKeyOf("300.1.1.1")).toBeUndefined();
  });
});

describe("service area", () => {
  it.each([
    ["Tel Aviv", 32.08, 34.78],
    ["Jerusalem", 31.77, 35.21],
    ["Haifa", 32.8, 35.0],
    ["Eilat", 29.56, 34.95],
    ["Beer Sheva", 31.25, 34.79],
    ["Katzrin", 32.99, 35.69],
    ["Metula", 33.28, 35.58],
    ["Nahariya", 33.0, 35.09],
    ["Ashkelon", 31.67, 34.57],
  ])("contains %s", (_, latitude, longitude) => {
    expect(inServiceArea(latitude, longitude)).toBe(true);
    expect(classifyAreaCell(latLngToCell(latitude, longitude, 7))).toBe("inside");
  });

  it.each([
    ["Amman", 31.95, 35.93],
    ["Beirut", 33.89, 35.5],
    ["Cairo", 30.04, 31.24],
    ["Damascus", 33.51, 36.29],
    ["Paris", 48.85, 2.35],
  ])("leaves out %s", (_, latitude, longitude) => {
    expect(classifyAreaCell(latLngToCell(latitude, longitude, 7))).toBe("outside");
  });

  it("accepts only H3 cells at resolution 7", () => {
    expect(classifyAreaCell(latLngToCell(32.08, 34.78, 6))).toBe("invalid");
    expect(classifyAreaCell(latLngToCell(32.08, 34.78, 8))).toBe("invalid");
    expect(classifyAreaCell("872830828ffffff".toUpperCase())).toBe("invalid");
    expect(classifyAreaCell("87283082fffffff0")).toBe("invalid");
    expect(classifyAreaCell("000000000000000")).toBe("invalid");
  });
});

describe("trusted proxies", () => {
  const resolve = async (proxies: string[], peer: string, forwarded?: string) => {
    const app = new Hono();
    const resolver = clientAddressResolver(proxies, () => peer);
    app.get("/", (c) => c.text(resolver(c) ?? "none"));
    const headers: Record<string, string> =
      forwarded === undefined ? {} : { "x-forwarded-for": forwarded };
    const response = await app.request("/", { headers });
    return response.text();
  };

  it("parses addresses and ranges, and names the first invalid entry", () => {
    expect(parseTrustedProxies("")).toEqual({ ok: true, entries: [] });
    expect(parseTrustedProxies(" 172.18.0.0/16, 10.0.0.1 fd00::/8 ")).toEqual({
      ok: true,
      entries: ["172.18.0.0/16", "10.0.0.1", "fd00::/8"],
    });
    expect(parseTrustedProxies("10.0.0.0/8,10.0.0.0/33")).toEqual({
      ok: false,
      invalid: "10.0.0.0/33",
    });
    expect(parseTrustedProxies("traefik")).toEqual({ ok: false, invalid: "traefik" });
  });

  it("uses the TCP peer when it is not a trusted proxy, whatever the header says", async () => {
    expect(await resolve([], "203.0.113.5", "198.51.100.1")).toBe("203.0.113.5");
    expect(await resolve(["10.0.0.0/8"], "203.0.113.5", "198.51.100.1")).toBe("203.0.113.5");
  });

  it("takes the right-most address that is not a trusted proxy", async () => {
    const proxies = ["10.0.0.0/8", "fd00::/8"];
    expect(await resolve(proxies, "10.0.0.2", "198.51.100.1")).toBe("198.51.100.1");
    expect(await resolve(proxies, "10.0.0.2", "192.0.2.66, 198.51.100.1")).toBe("198.51.100.1");
    expect(await resolve(proxies, "10.0.0.2", "192.0.2.66, 198.51.100.1, 10.0.0.9")).toBe(
      "198.51.100.1",
    );
    expect(await resolve(proxies, "::ffff:10.0.0.2", "2001:db8::5")).toBe("2001:db8::5");
    expect(await resolve(proxies, "fd00::2", "::ffff:198.51.100.3")).toBe("198.51.100.3");
  });

  it("stops at the last trusted hop on a malformed entry, and without a header uses the peer", async () => {
    const proxies = ["10.0.0.0/8"];
    expect(await resolve(proxies, "10.0.0.2", "198.51.100.1, garbage")).toBe("10.0.0.2");
    expect(await resolve(proxies, "10.0.0.2", "garbage, 10.0.0.3")).toBe("10.0.0.3");
    expect(await resolve(proxies, "10.0.0.2")).toBe("10.0.0.2");
    expect(await resolve(proxies, "10.0.0.2", "10.0.0.7, 10.0.0.3")).toBe("10.0.0.7");
  });
});

describe("GeoLite2-ASN reader", () => {
  let dir: string;
  let path: string;
  const built = Date.UTC(2026, 9, 28) / 1000;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mashkif-geoip-"));
    path = join(dir, "GeoLite2-ASN.mmdb");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (buffer: Buffer, mtimeSeconds: number) => {
    await writeFile(path, buffer);
    await utimes(path, mtimeSeconds, mtimeSeconds);
  };

  it("is unavailable without a file and finds ASNs once a database is there", async () => {
    const warnings: string[] = [];
    const lookup = new GeoLiteAsn(path, (line) => warnings.push(line));
    await lookup.refresh();
    expect(lookup.status()).toMatchObject({ state: "unavailable" });
    expect(lookup.lookup("198.51.100.7")).toBeUndefined();
    expect(warnings).toHaveLength(1);

    await write(
      writeAsnDatabase(
        [
          { network: "198.51.100.0/24", asn: 64500, organization: "Example Net" },
          { network: "2001:db8::/32", asn: 64501, organization: "Example Six" },
        ],
        built,
      ),
      1_000,
    );
    await lookup.refresh();
    expect(lookup.lookup("198.51.100.7")).toEqual({ asn: 64500, organization: "Example Net" });
    expect(lookup.lookup("2001:db8:1::5")).toEqual({ asn: 64501, organization: "Example Six" });
    expect(lookup.lookup("203.0.113.1")).toBeUndefined();
    expect(lookup.lookup("not an address")).toBeUndefined();
    expect(lookup.status(new Date(built * 1000 + 24 * 60 * 60 * 1000))).toEqual({
      state: "ok",
      buildDate: "2026-10-28T00:00:00.000Z",
      stale: false,
    });
    expect(lookup.status(new Date(built * 1000 + 15 * 24 * 60 * 60 * 1000)).stale).toBe(true);
  });

  it("keeps the last good database when the file is replaced by a broken one, and loads a new good one", async () => {
    const warnings: string[] = [];
    const lookup = new GeoLiteAsn(path, (line) => warnings.push(line));
    await write(
      writeAsnDatabase([{ network: "198.51.100.0/24", asn: 64500, organization: "A" }], built),
      2_000,
    );
    await lookup.refresh();
    await write(Buffer.from("not a database at all, just bytes"), 3_000);
    await lookup.refresh();
    expect(lookup.lookup("198.51.100.7")?.asn).toBe(64500);
    expect(warnings.join("\n")).toContain("previous database stays in use");
    // The same broken file is not reported again on every check.
    await lookup.refresh();
    expect(warnings).toHaveLength(1);

    await write(
      writeAsnDatabase([{ network: "198.51.100.0/24", asn: 64999, organization: "B" }], built),
      4_000,
    );
    await lookup.refresh();
    expect(lookup.lookup("198.51.100.7")).toEqual({ asn: 64999, organization: "B" });
  });

  it("starts with an unreadable file without throwing", async () => {
    await write(Buffer.alloc(4096, 7), 5_000);
    const lookup = new GeoLiteAsn(path, () => {});
    await lookup.start(60_000);
    lookup.stop();
    expect(lookup.status().state).toBe("unavailable");
  });
});
