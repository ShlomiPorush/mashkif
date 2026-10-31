import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readableFileCheck, runReadiness } from "../src/readiness.js";

const ok = async () => {};
const broken = async () => {
  throw new Error("connection refused");
};
const hanging = () => new Promise<void>(() => {});

describe("runReadiness", () => {
  it("is ready when every check passes", async () => {
    await expect(runReadiness({ database: ok, geoip: ok })).resolves.toEqual({
      status: "ready",
      checks: { database: "ok", geoip: "ok" },
      failing: [],
    });
  });

  it("names the failing check and reports the reason", async () => {
    const reasons: string[] = [];
    const report = await runReadiness({ database: broken, geoip: ok }, 1000, (name, reason) =>
      reasons.push(`${name}: ${reason}`),
    );
    expect(report).toEqual({
      status: "not_ready",
      checks: { database: "failed", geoip: "ok" },
      failing: ["database"],
    });
    expect(reasons).toEqual(["database: Error: connection refused"]);
  });

  it("fails a check that does not answer in time", async () => {
    const started = Date.now();
    const report = await runReadiness({ database: hanging, geoip: broken }, 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(report.failing).toEqual(["database", "geoip"]);
  });
});

describe("readableFileCheck", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mashkif-readiness-"));
    await writeFile(join(dir, "GeoLite2-ASN.mmdb"), "placeholder");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes for a readable file", async () => {
    await expect(readableFileCheck(join(dir, "GeoLite2-ASN.mmdb"))()).resolves.toBeUndefined();
  });

  it("fails for a missing file", async () => {
    await expect(readableFileCheck(join(dir, "missing.mmdb"))()).rejects.toThrow(/ENOENT/);
  });

  it("fails for a directory", async () => {
    await expect(readableFileCheck(dir)()).rejects.toThrow();
  });
});
