import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  CURRENT_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/protocol.js";

const ok = async () => {};
const broken = async () => {
  throw new Error("unavailable");
};

const ready = createApp({ readiness: { database: ok, geoip: ok } });

describe("health endpoints", () => {
  it("GET /healthz is always 200", async () => {
    const app = createApp({ readiness: { database: broken, geoip: broken } });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET /readyz is 200 when every dependency works", async () => {
    const response = await ready.request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready", failing: [] });
  });

  it.each([
    ["database", { database: broken, geoip: ok }],
    ["geoip", { database: ok, geoip: broken }],
  ] as const)("GET /readyz is 503 naming %s when it fails", async (name, readiness) => {
    const response = await createApp({ readiness }).request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", failing: [name] });
  });
});

describe("agent protocol", () => {
  it("negotiates the protocol version header", () => {
    expect(negotiateProtocolVersion(undefined)).toEqual({
      ok: false,
      error: "protocol_version_missing",
    });
    expect(negotiateProtocolVersion(" ")).toEqual({ ok: false, error: "protocol_version_missing" });
    expect(negotiateProtocolVersion("v1")).toEqual({
      ok: false,
      error: "protocol_version_invalid",
    });
    expect(negotiateProtocolVersion("01")).toEqual({
      ok: false,
      error: "protocol_version_invalid",
    });
    expect(negotiateProtocolVersion("999")).toEqual({
      ok: false,
      error: "protocol_version_unsupported",
    });
    expect(negotiateProtocolVersion("1")).toEqual({ ok: true, version: 1 });
  });

  it("supports the current version", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(CURRENT_PROTOCOL_VERSION);
  });

  it("GET /api/agent/health answers with the version it used", async () => {
    const response = await ready.request("/api/agent/health", {
      headers: { [PROTOCOL_VERSION_HEADER]: "1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(PROTOCOL_VERSION_HEADER)).toBe("1");
    expect(await response.json()).toEqual({ status: "ok", protocolVersion: 1 });
  });

  it.each([
    [undefined, "protocol_version_missing"],
    ["abc", "protocol_version_invalid"],
    ["2", "protocol_version_unsupported"],
  ])("GET /api/agent/health with version %s is 400 %s", async (version, error) => {
    const headers: Record<string, string> = {};
    if (version !== undefined) {
      headers[PROTOCOL_VERSION_HEADER] = version;
    }
    const response = await ready.request("/api/agent/health", { headers });
    expect(response.status).toBe(400);
    expect(response.headers.get(PROTOCOL_VERSION_HEADER)).toBe(String(CURRENT_PROTOCOL_VERSION));
    expect(await response.json()).toEqual({ error, supportedVersions: [1] });
  });

  it("unknown API paths are JSON 404", async () => {
    const response = await ready.request("/api/unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("web app on the same origin", () => {
  let webRoot: string;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "mashkif-web-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Mashkif</title>");
    await writeFile(join(webRoot, "assets", "index-abc123.js"), "console.log(1);");
  });

  afterAll(async () => {
    await rm(webRoot, { recursive: true, force: true });
  });

  const web = () => createApp({ readiness: { database: ok, geoip: ok }, webRoot });

  it("serves index.html at the root without long caching", async () => {
    const response = await web().request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toContain("<title>Mashkif</title>");
  });

  it("serves hashed assets with long caching", async () => {
    const response = await web().request("/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("falls back to index.html for client-side routes", async () => {
    const response = await web().request("/some/page");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Mashkif</title>");
  });

  it("keeps missing files and API paths 404", async () => {
    expect((await web().request("/assets/missing.js")).status).toBe(404);
    expect((await web().request("/missing.png")).status).toBe(404);
    expect((await web().request("/api/unknown")).status).toBe(404);
  });

  it("never serves files outside the web root", async () => {
    for (const path of ["/assets/..%2f..%2f..%2fetc%2fpasswd", "/..%2f..%2fetc/passwd"]) {
      const response = await web().request(path);
      expect(await response.text()).not.toContain("root:");
    }
    expect((await web().request("/assets/..%2f..%2f..%2fetc%2fpasswd")).status).toBe(404);
  });

  it("sends a content security policy", async () => {
    const response = await web().request("/");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
