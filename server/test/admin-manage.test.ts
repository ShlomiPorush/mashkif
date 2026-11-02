import { latLngToCell } from "h3-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAdmin } from "../src/admin/reset.js";
import { hashToken } from "../src/admin/setup.js";
import { fullAdmin, insertKey, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { Browser, createHarness, type Harness, setUpAdmin, USERNAME } from "./support/harness.js";

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
  ["GET", "/api/admin/enrollment-keys"],
  ["POST", "/api/admin/enrollment-keys", { label: "PC" }],
  ["POST", "/api/admin/enrollment-keys/1/revoke"],
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
    await setUpAdmin(database, harness);
    const reply = await new Browser(harness).request(method, path, { json });
    expect(reply).toMatchObject({ status: 401, body: { error: "session_required" } });
  });

  it.each(ROUTES)("%s %s refuses a password-only session", async (method, path, json) => {
    await setUpAdmin(database, harness);
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);
    expect(await browser.sessionState()).toBe("enrollment");
    const reply = await browser.request(method, path, { json });
    expect(reply).toMatchObject({ status: 403, body: { error: "totp_required" } });
  });

  it.each(ROUTES)("%s %s works with a full session", async (method, path, json) => {
    const browser = await fullAdmin(database, harness);
    const reply = await browser.request(method, path, { json });
    expect(reply.status).not.toBe(401);
    expect(reply.status).not.toBe(403);
    expect(reply.status).toBeLessThan(500);
  });

  it.each(ROUTES.filter(([method]) => method === "POST"))(
    "POST %s from another origin is refused",
    async (_, path, json) => {
      const browser = await fullAdmin(database, harness);
      const reply = await browser.request("POST", path.toString(), {
        json,
        origin: "https://evil.test",
      });
      expect(reply).toMatchObject({ status: 403, body: { error: "origin_rejected" } });
    },
  );

  it("commits nothing when reset-admin ended the session first", async () => {
    const browser = await fullAdmin(database, harness);
    await resetAdmin(database.db);
    const reply = await browser.post("/api/admin/enrollment-keys", { label: "PC" });
    expect(reply.status).toBe(401);
    expect(await database.sql`select 1 from enrollment_key`).toHaveLength(0);
    expect(await audits("enrollment_key")).toHaveLength(0);
  });
});

describe("enrollment keys", () => {
  it("shows a new key once, stores only its hash, and lets the agent use it", async () => {
    const browser = await fullAdmin(database, harness);
    const created = await browser.post("/api/admin/enrollment-keys", {
      label: "Kitchen PC",
      validHours: 2,
    });
    expect(created.status).toBe(201);
    const secret = String(created.body.secret);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [row] = await database.sql`select key_hash, label, expires_at, created_at, created_by
      from enrollment_key`;
    expect(row?.key_hash).toBe(hashToken(secret));
    expect(row?.created_by).toBe(USERNAME.toLowerCase());
    expect(Date.parse(String(row?.expires_at)) - Date.parse(String(row?.created_at))).toBe(
      2 * 60 * 60 * 1000,
    );

    const list = await browser.get("/api/admin/enrollment-keys");
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.keys).toMatchObject([
      { label: "Kitchen PC", status: "active", agentId: null },
    ]);

    const agent = new TestAgent(harness);
    expect((await agent.register(secret)).status).toBe(201);
    const after = await browser.get("/api/admin/enrollment-keys");
    expect(after.body.keys).toMatchObject([{ status: "used", agentId: expect.any(String) }]);

    const [audit] = await audits("enrollment_key");
    expect(audit).toMatchObject({
      actor: USERNAME.toLowerCase(),
      action: "enrollment_key.created",
      details: { label: "Kitchen PC" },
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("defaults to 24 hours and refuses a missing label or a validity over 7 days", async () => {
    const browser = await fullAdmin(database, harness);
    const created = await browser.post("/api/admin/enrollment-keys", { label: "PC" });
    const key = created.body.key as { createdAt: string; expiresAt: string };
    expect(Date.parse(key.expiresAt) - Date.parse(key.createdAt)).toBe(24 * 60 * 60 * 1000);
    expect((await browser.post("/api/admin/enrollment-keys", { label: " " })).body.error).toBe(
      "label_invalid",
    );
    expect(
      (await browser.post("/api/admin/enrollment-keys", { label: "PC", validHours: 169 })).body
        .error,
    ).toBe("valid_hours_invalid");
  });

  it("revokes an unused key, which the agent then cannot use, and refuses to revoke a used one", async () => {
    const browser = await fullAdmin(database, harness);
    const created = await browser.post("/api/admin/enrollment-keys", { label: "PC" });
    const id = (created.body.key as { id: number }).id;
    expect((await browser.post(`/api/admin/enrollment-keys/${id}/revoke`)).status).toBe(200);
    expect((await new TestAgent(harness).register(String(created.body.secret))).body.error).toBe(
      "enrollment_key_revoked",
    );
    expect((await browser.post(`/api/admin/enrollment-keys/${id}/revoke`)).status).toBe(409);
    expect((await browser.post("/api/admin/enrollment-keys/999/revoke")).status).toBe(404);

    const used = await insertKey(database);
    await new TestAgent(harness).register(used);
    const [usedRow] = await database.sql`select id from enrollment_key where used_at is not null`;
    expect(
      (await browser.post(`/api/admin/enrollment-keys/${usedRow?.id}/revoke`)).body.error,
    ).toBe("enrollment_key_not_revocable");
    expect((await audits("enrollment_key.revoked")).length).toBe(1);
  });
});

describe("agents", () => {
  it("lists agents with site address, ASN, provider, area, infrastructure, and tier", async () => {
    const browser = await fullAdmin(database, harness);
    harness.asn.table.set("203.0.113.", { asn: 64500, organization: "Example Net" });
    await browser.post("/api/admin/providers", { name: "Example", asns: [64500] });
    const agent = await new TestAgent(harness).enroll(database);
    await agent.heartbeat({ areaCell: TEL_AVIV, infrastructure: "hot", agentVersion: "0.2.0" });

    const reply = await browser.get("/api/admin/agents");
    expect(reply.body.agents).toMatchObject([
      {
        id: agent.agentId,
        label: "test PC",
        trustTier: "normal",
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
  });

  it("changes trust tier, label, and assigned area with one audit entry each", async () => {
    const browser = await fullAdmin(database, harness);
    const agent = await new TestAgent(harness).enroll(database);
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
    const browser = await fullAdmin(database, harness);
    const agent = await new TestAgent(harness).enroll(database);
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
    const browser = await fullAdmin(database, harness);
    const agent = await new TestAgent(harness).enroll(database);
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(200);
    expect((await agent.heartbeat()).body.error).toBe("agent_revoked");
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(409);
    expect(await audits("agent.revoked")).toMatchObject([
      { action: "agent.revoked", details: { agentId: agent.agentId } },
    ]);
  });

  it("blocks and unblocks an agent through its trust tier", async () => {
    const browser = await fullAdmin(database, harness);
    const agent = await new TestAgent(harness).enroll(database);
    await browser.post(`/api/admin/agents/${agent.agentId}`, { trustTier: "blocked" });
    expect((await agent.heartbeat()).body.error).toBe("agent_blocked");
    await browser.post(`/api/admin/agents/${agent.agentId}`, { trustTier: "normal" });
    expect((await agent.heartbeat()).status).toBe(200);
  });
});

describe("blocked addresses and ranges", () => {
  it("normalizes, lists, refuses duplicates, and removes, with audit entries", async () => {
    const browser = await fullAdmin(database, harness);
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

    const blocked = await new TestAgent(harness, "203.0.113.9").register(await insertKey(database));
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
    const browser = await fullAdmin(database, harness);
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
    const browser = await fullAdmin(database, harness);
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
    expect(saved.body).toEqual({ heartbeatIntervalSeconds: 120, retentionDays: 14 });
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
    const agent = await new TestAgent(harness).enroll(database);
    expect((await agent.heartbeat()).body.nextIntervalSeconds).toBe(120);
  });
});
