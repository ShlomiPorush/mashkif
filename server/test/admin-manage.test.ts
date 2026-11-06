import { randomBytes, randomInt } from "node:crypto";
import { latLngToCell } from "h3-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedSettings, SETTINGS_CACHE_TTL_MS } from "../src/settings.js";
import { fullAdmin, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { Browser, createHarness, type Harness, setUpAdmin } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const TEL_AVIV = latLngToCell(32.08, 34.78, 7);
const PARIS = latLngToCell(48.85, 2.35, 7);
const SOME_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  harness = createHarness(database);
});

async function audits(prefix: string) {
  return database.sql`select actor, action, details from audit_log
    where action like ${`${prefix}%`} and action <> 'agent.registered' order by id`;
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/admin/agents"],
  ["POST", `/api/admin/agents/${SOME_ID}`, { label: "x" }],
  ["POST", `/api/admin/agents/${SOME_ID}/revoke`],
  ["GET", "/api/admin/blocked-ranges"],
  ["POST", "/api/admin/blocked-ranges", { range: "192.0.2.0/24" }],
  ["POST", "/api/admin/blocked-ranges/1/delete"],
  ["GET", "/api/admin/providers"],
  ["POST", "/api/admin/providers", { name: "Example", asns: [64500] }],
  ["POST", "/api/admin/providers/1", { name: "Example", asns: [] }],
  ["POST", "/api/admin/providers/1/delete"],
  ["GET", "/api/admin/settings"],
  ["POST", "/api/admin/settings", { retentionDays: 9 }],
];

describe("authorization of the management routes", () => {
  it.each(ROUTES)("%s %s needs a session", async (method, path, json) => {
    await setUpAdmin(harness);
    const reply = await new Browser(harness).request(method, path, { json });
    expect(reply).toMatchObject({ status: 401, body: { error: "session_required" } });
  });

  it.each(ROUTES)("%s %s refuses a session without TOTP", async (method, path, json) => {
    const browser = await setUpAdmin(harness);
    expect(await browser.sessionState()).toBe("enrollment");
    const reply = await browser.request(method, path, { json });
    expect(reply).toMatchObject({ status: 403, body: { error: "totp_required" } });
  });

  it.each(ROUTES)("%s %s works with a full session", async (method, path, json) => {
    const browser = await fullAdmin(harness);
    const reply = await browser.request(method, path, { json });
    expect(reply.status).not.toBe(401);
    expect(reply.status).not.toBe(403);
    expect(reply.status).toBeLessThan(500);
  });

  it.each(ROUTES.filter(([method]) => method === "POST"))(
    "POST %s from another origin is refused",
    async (_, path, json) => {
      const browser = await fullAdmin(harness);
      const reply = await browser.request("POST", path.toString(), {
        json,
        origin: "https://evil.test",
      });
      expect(reply).toMatchObject({ status: 403, body: { error: "origin_rejected" } });
    },
  );
});

describe("enrollment keys", () => {
  it("are gone: open registration replaced them (2026-11-03)", async () => {
    const browser = await fullAdmin(harness);
    expect((await browser.get("/api/admin/enrollment-keys")).status).toBe(404);
    expect((await browser.post("/api/admin/enrollment-keys", { label: "PC" })).status).toBe(404);
  });
});

describe("agents", () => {
  it("lists agents with site address, ASN, provider, area, infrastructure, and tier", async () => {
    const browser = await fullAdmin(harness);
    harness.asn.table.set("203.0.113.", { asn: 64500, organization: "Example Net" });
    await browser.post("/api/admin/providers", { name: "Example", asns: [64500] });
    const agent = await new TestAgent(harness).enroll();
    await agent.heartbeat({ areaCell: TEL_AVIV, infrastructure: "hot", agentVersion: "0.2.0" });

    const reply = await browser.get("/api/admin/agents");
    expect(reply.body.agents).toMatchObject([
      {
        id: agent.agentId,
        label: null,
        trustTier: "low",
        activeDays: 1,
        agentVersion: "0.2.0",
        address: "203.0.113.5",
        siteKey: "203.0.113.5",
        asn: 64500,
        asOrganization: "Example Net",
        providerName: "Example",
        reportedCell: TEL_AVIV,
        assignedCell: null,
        infrastructure: "hot",
        silenceIntervalSeconds: 60,
        revokedAt: null,
      },
    ]);
    expect(reply.body.promotionDays).toBe(7);
  });

  it("changes trust tier, label, and assigned area with one audit entry each", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll();
    const path = `/api/admin/agents/${agent.agentId}`;
    expect(
      (await browser.post(path, { trustTier: "trusted", label: "Office", assignedCell: TEL_AVIV }))
        .status,
    ).toBe(200);
    const [row] = await database.sql`select trust_tier, label, assigned_cell from agent`;
    expect(row).toEqual({ trust_tier: "trusted", label: "Office", assigned_cell: TEL_AVIV });
    expect((await audits("agent.")).map((item) => item.action)).toEqual([
      "agent.trust_tier_changed",
      "agent.label_changed",
      "agent.area_assigned",
    ]);

    // The assigned area is kept apart from the reported one and survives heartbeats.
    await agent.heartbeat({ areaCell: null });
    expect((await database.sql`select assigned_cell from agent`)[0]?.assigned_cell).toBe(TEL_AVIV);

    expect((await browser.post(path, { assignedCell: null })).status).toBe(200);
    expect((await audits("agent.area_cleared")).length).toBe(1);
    // An unchanged value writes no entry.
    await browser.post(path, { label: "Office" });
    expect((await audits("agent.label_changed")).length).toBe(1);
  });

  it("refuses an invalid tier, label, or area", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll();
    const path = `/api/admin/agents/${agent.agentId}`;
    expect((await browser.post(path, { trustTier: "vip" })).body.error).toBe("trust_tier_invalid");
    expect((await browser.post(path, { label: "x".repeat(101) })).body.error).toBe("label_invalid");
    expect((await browser.post(path, { assignedCell: "nope" })).body.error).toBe(
      "area_cell_invalid",
    );
    expect((await browser.post(path, { assignedCell: PARIS })).body.error).toBe(
      "area_outside_service_area",
    );
    expect((await browser.post(`/api/admin/agents/${SOME_ID}`, { label: "x" })).status).toBe(404);
    expect(await audits("agent.")).toHaveLength(0);
  });

  it("revokes an agent, whose token then stops working", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll();
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(200);
    expect((await agent.heartbeat()).body.error).toBe("agent_revoked");
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(409);
    expect(await audits("agent.revoked")).toMatchObject([
      { action: "agent.revoked", details: { agentId: agent.agentId } },
    ]);
  });

  it("blocks and unblocks an agent through its trust tier", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll();
    await browser.post(`/api/admin/agents/${agent.agentId}`, { trustTier: "blocked" });
    expect((await agent.heartbeat()).body.error).toBe("agent_blocked");
    await browser.post(`/api/admin/agents/${agent.agentId}`, { trustTier: "normal" });
    expect((await agent.heartbeat()).status).toBe(200);
  });
});

describe("blocked addresses and ranges", () => {
  it("normalizes, lists, refuses duplicates, and removes, with audit entries", async () => {
    const browser = await fullAdmin(harness);
    expect(
      await browser.post("/api/admin/blocked-ranges", { range: "203.0.113.77/24", note: "spam" }),
    ).toMatchObject({ status: 201, body: { range: "203.0.113.0/24" } });
    expect(
      (await browser.post("/api/admin/blocked-ranges", { range: "2001:db8::1" })).body,
    ).toMatchObject({
      range: "2001:db8::1/128",
    });
    expect(
      (await browser.post("/api/admin/blocked-ranges", { range: "203.0.113.0/24" })).body.error,
    ).toBe("range_exists");
    for (const range of ["300.1.1.1", "1.2.3.4/33", "example.com", ""]) {
      expect((await browser.post("/api/admin/blocked-ranges", { range })).body.error).toBe(
        "range_invalid",
      );
    }
    const list = await browser.get("/api/admin/blocked-ranges");
    expect((list.body.ranges as { range: string }[]).map((item) => item.range)).toEqual([
      "2001:db8::1/128",
      "203.0.113.0/24",
    ]);

    const blocked = await new TestAgent(harness, "203.0.113.9").register();
    expect(blocked.body.error).toBe("address_blocked");

    const id = (list.body.ranges as { id: number }[])[1]?.id;
    expect((await browser.post(`/api/admin/blocked-ranges/${id}/delete`)).status).toBe(200);
    expect((await audits("blocked_range")).map((item) => item.action)).toEqual([
      "blocked_range.added",
      "blocked_range.added",
      "blocked_range.removed",
    ]);
  });
});

describe("providers", () => {
  it("creates, edits, and deletes providers; an ASN belongs to one provider", async () => {
    const browser = await fullAdmin(harness);
    const created = await browser.post("/api/admin/providers", {
      name: "Example",
      asns: [64501, 64500, 64500],
    });
    expect(created).toMatchObject({ status: 201, body: { asns: [64500, 64501] } });
    const other = await browser.post("/api/admin/providers", { name: "Other", asns: [64500] });
    expect(other).toMatchObject({ status: 409, body: { error: "asn_taken", asns: [64500] } });
    expect((await database.sql`select 1 from provider`).length).toBe(1);
    expect((await browser.post("/api/admin/providers", { name: "Example" })).body.error).toBe(
      "provider_exists",
    );
    expect((await browser.post("/api/admin/providers", { name: "X", asns: [0] })).body.error).toBe(
      "asns_invalid",
    );

    const id = created.body.id;
    expect(
      (await browser.post(`/api/admin/providers/${id}`, { name: "Example 2", asns: [64502] }))
        .status,
    ).toBe(200);
    expect((await browser.get("/api/admin/providers")).body.providers).toEqual([
      { id, name: "Example 2", asns: [64502] },
    ]);
    expect((await browser.post(`/api/admin/providers/${id}/delete`)).status).toBe(200);
    expect(await database.sql`select 1 from provider_asn`).toHaveLength(0);
    expect((await audits("provider")).map((item) => item.action)).toEqual([
      "provider.created",
      "provider.updated",
      "provider.deleted",
    ]);
  });
});

describe("settings", () => {
  it("starts from the development defaults, validates, saves, audits, and reaches agents", async () => {
    const browser = await fullAdmin(harness);
    expect((await browser.get("/api/admin/settings")).body).toMatchObject({
      heartbeatIntervalSeconds: 60,
      retentionDays: 30,
      geoip: { state: "ok" },
    });
    for (const body of [
      { heartbeatIntervalSeconds: 29 },
      { heartbeatIntervalSeconds: 601 },
      { retentionDays: 7 },
      { retentionDays: "30" },
    ]) {
      expect((await browser.post("/api/admin/settings", body)).body.error).toBe("setting_invalid");
    }
    const saved = await browser.post("/api/admin/settings", {
      heartbeatIntervalSeconds: 120,
      retentionDays: 14,
    });
    expect(saved.body).toMatchObject({ heartbeatIntervalSeconds: 120, retentionDays: 14 });
    expect(await audits("settings")).toMatchObject([
      {
        action: "settings.updated",
        details: {
          changes: {
            heartbeatIntervalSeconds: { from: 60, to: 120 },
            retentionDays: { from: 30, to: 14 },
          },
        },
      },
    ]);
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).body.nextIntervalSeconds).toBe(120);
  });

  it("serves the register path from a cache that expires and that a panel save refreshes", async () => {
    const browser = await fullAdmin(harness);
    expect((await cachedSettings(database.db, 1_000)).registrationOpen).toBe(true);
    // A change behind the panel's back is seen only after the TTL.
    await database.sql`insert into setting (key, value, updated_by)
      values ('registration_open', 'false'::jsonb, 'test')`;
    expect((await cachedSettings(database.db, 2_000)).registrationOpen).toBe(true);
    const expired = 1_000 + SETTINGS_CACHE_TTL_MS;
    expect((await cachedSettings(database.db, expired)).registrationOpen).toBe(false);
    // A save from the panel is seen at once.
    expect((await browser.post("/api/admin/settings", { registrationOpen: true })).status).toBe(
      200,
    );
    expect((await cachedSettings(database.db, expired + 1)).registrationOpen).toBe(true);
  });
  it("manages the open enrollment settings with their defaults and ranges", async () => {
    const browser = await fullAdmin(harness);
    expect((await browser.get("/api/admin/settings")).body).toMatchObject({
      registrationOpen: true,
      newAgentTier: "low",
      promotionDays: 7,
      registerPerSitePer10Min: 10,
      registerGlobalPerHour: 200,
      eventsPerAgentHour: 2000,
      eventsPerLowAgentHour: 200,
      agentCleanupDays: 30,
    });
    for (const body of [
      { registrationOpen: "yes" },
      { newAgentTier: "trusted" },
      { newAgentTier: "blocked" },
      { promotionDays: 0 },
      { promotionDays: 91 },
      { registerPerSitePer10Min: 0 },
      { registerGlobalPerHour: 100_001 },
      { eventsPerAgentHour: 99 },
      { eventsPerLowAgentHour: 9 },
      { agentCleanupDays: 6 },
    ]) {
      expect((await browser.post("/api/admin/settings", body)).body.error).toBe("setting_invalid");
    }
    const saved = await browser.post("/api/admin/settings", {
      registrationOpen: false,
      newAgentTier: "suspicious",
      promotionDays: 14,
    });
    expect(saved.body).toMatchObject({
      registrationOpen: false,
      newAgentTier: "suspicious",
      promotionDays: 14,
    });
    expect((await new TestAgent(harness).register()).body.error).toBe("registration_closed");
    await browser.post("/api/admin/settings", { registrationOpen: true });
    expect((await new TestAgent(harness).register()).status).toBe(201);
    const [row] = await database.sql`select trust_tier from agent`;
    expect(row?.trust_tier).toBe("suspicious");
  });
});

describe("settings from the environment", () => {
  const envPassword = randomBytes(18).toString("base64url");
  const ENV = {
    BETTER_AUTH_URL: "https://mashkif.example",
    MASHKIF_SESSION_HOURS: "8",
    MASHKIF_TRUSTED_PROXIES: "172.18.0.0/16",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://other.example",
    MASHKIF_SMTP_HOST: "smtp.example",
    MASHKIF_SMTP_PORT: "587",
    MASHKIF_SMTP_USER: "mailer",
    MASHKIF_SMTP_PASSWORD: envPassword,
    MASHKIF_SMTP_FROM: "mashkif@mashkif.example",
  };

  it("lets every environment override win over the stored value and reports it locked", async () => {
    harness = createHarness(database, { env: ENV });
    const browser = await fullAdmin(harness);
    // Stored values that the environment overrides.
    await database.sql`insert into setting (key, value, updated_by) values
      ('public_url', '"https://stored.example"', 'test'),
      ('session_hours', '24', 'test'),
      ('smtp_host', '"stored.example"', 'test'),
      ('smtp_port', '465', 'test')`;
    const reply = await browser.get("/api/admin/settings");
    expect(reply.body).toMatchObject({
      publicUrl: "https://mashkif.example",
      sessionHours: 8,
      trustedProxies: ["172.18.0.0/16"],
      trustedOrigins: ["https://other.example"],
      smtpHost: "smtp.example",
      smtpPort: 587,
      smtpUser: "mailer",
      smtpPasswordSet: true,
      smtpFrom: "mashkif@mashkif.example",
      apply: { publicUrl: "restart", trustedOrigins: "now", smtpHost: "next_email" },
      env: { publicUrl: "BETTER_AUTH_URL", smtpPassword: "MASHKIF_SMTP_PASSWORD" },
    });
    expect([...(reply.body.locked as string[])].sort()).toEqual(
      [
        "publicUrl",
        "sessionHours",
        "smtpFrom",
        "smtpHost",
        "smtpPassword",
        "smtpPort",
        "smtpUser",
        "trustedOrigins",
        "trustedProxies",
      ].sort(),
    );
    expect(JSON.stringify(reply.body)).not.toContain(envPassword);
    // A locked setting cannot be changed in the panel.
    for (const field of ["publicUrl", "sessionHours", "smtpPassword", "trustedProxies"]) {
      const value = field === "sessionHours" ? 4 : field === "trustedProxies" ? [] : "x";
      expect((await browser.post("/api/admin/settings", { [field]: value })).body).toEqual({
        error: "setting_locked",
        field,
      });
    }
    // Unlocked settings stay editable.
    expect((await browser.post("/api/admin/settings", { retentionDays: 10 })).status).toBe(200);
  });

  it("keeps a secret from the environment exactly as given, spaces included", async () => {
    const { resolveSettings } = await import("../src/settings.js");
    const spaced = `  ${randomBytes(18).toString("base64url")}  `;
    const env = { MASHKIF_SMTP_PASSWORD: spaced, MASHKIF_SMTP_USER: "  mailer  " };
    const resolved = await resolveSettings(database.db, { env, secret: harness.secret });
    expect(resolved.values.smtpPassword).toBe(spaced);
    // Other settings are trimmed.
    expect(resolved.values.smtpUser).toBe("mailer");
    expect(resolved.locked).toEqual(expect.arrayContaining(["smtpPassword", "smtpUser"]));
    // Empty is not set; whitespace alone is a password.
    expect(
      (await resolveSettings(database.db, { env: { MASHKIF_SMTP_PASSWORD: "" } })).locked,
    ).toEqual([]);
    // A random mix of spaces and tabs, 1 to 8 long.
    const blank = Array.from({ length: randomInt(1, 9) }, () =>
      randomInt(2) === 0 ? " " : "\t",
    ).join("");
    expect(
      (await resolveSettings(database.db, { env: { MASHKIF_SMTP_PASSWORD: blank } })).values
        .smtpPassword,
    ).toBe(blank);
  });

  it("an empty environment variable does not lock its setting", async () => {
    harness = createHarness(database, {
      env: { MASHKIF_TRUSTED_PROXIES: " ", BETTER_AUTH_URL: "" },
    });
    const browser = await fullAdmin(harness);
    const reply = await browser.get("/api/admin/settings");
    expect(reply.body.locked).toEqual([]);
    expect(reply.body).toMatchObject({ publicUrl: "", trustedProxies: [] });
  });
});

describe("panel settings", () => {
  it("validates and saves the sign-in, proxy, and mail settings", async () => {
    const browser = await fullAdmin(harness);
    for (const body of [
      { publicUrl: "http://mashkif.example" },
      { publicUrl: "https://mashkif.example/admin" },
      { trustedOrigins: ["not a url"] },
      { trustedProxies: ["300.1.1.1"] },
      { sessionHours: 0 },
      { sessionHours: 169 },
      { smtpPort: 70000 },
      { smtpHost: "bad host" },
      { smtpFrom: "not-an-address" },
    ]) {
      expect(
        (await browser.post("/api/admin/settings", body)).body.error,
        JSON.stringify(body),
      ).toBe("setting_invalid");
    }
    const saved = await browser.post("/api/admin/settings", {
      publicUrl: "https://mashkif.example/",
      trustedOrigins: ["https://other.example"],
      trustedProxies: ["172.18.0.0/16", "10.0.0.1"],
      sessionHours: 6,
      smtpHost: "smtp.example",
      smtpPort: 587,
      smtpUser: "mailer",
      smtpFrom: "mashkif@mashkif.example",
    });
    expect(saved.body).toMatchObject({
      publicUrl: "https://mashkif.example",
      trustedOrigins: ["https://other.example"],
      trustedProxies: ["172.18.0.0/16", "10.0.0.1/32"],
      sessionHours: 6,
      smtpPort: 587,
      smtpPasswordSet: false,
      locked: [],
    });
  });

  it("stores the SMTP password encrypted, never returns it, and keeps it out of the audit log", async () => {
    const browser = await fullAdmin(harness);
    const password = randomBytes(18).toString("base64url");
    const saved = await browser.post("/api/admin/settings", { smtpPassword: password });
    expect(saved.status).toBe(200);
    expect(saved.body.smtpPasswordSet).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(password);
    expect(JSON.stringify((await browser.get("/api/admin/settings")).body)).not.toContain(password);
    const [row] = await database.sql`select value from setting where key = 'smtp_password'`;
    expect(typeof row?.value).toBe("string");
    expect(String(row?.value)).not.toContain(password);
    expect(JSON.stringify(await audits("settings"))).not.toContain(password);
    expect(await audits("settings")).toMatchObject([
      { details: { changes: { smtpPassword: { changed: true } } } },
    ]);
    // The stored value decrypts to the password with the Better Auth secret only.
    const { resolveSettings } = await import("../src/settings.js");
    const own = await resolveSettings(database.db, { env: {}, secret: harness.secret });
    expect(own.values.smtpPassword).toBe(password);
    const other = await resolveSettings(database.db, {
      env: {},
      secret: randomBytes(32).toString("base64"),
    });
    expect(other.values.smtpPassword).toBe("");
  });
});
