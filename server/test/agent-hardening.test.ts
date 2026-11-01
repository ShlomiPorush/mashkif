import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UNKNOWN_TOKEN_RATE_LIMIT } from "../src/agent/routes.js";
import { MemoryRateLimitStore } from "../src/auth/rate-limit.js";
import { runRetention } from "../src/retention.js";
import { fullAdmin, insertKey, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness, pauseOnce, untilLockWaiter } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const DAY = 24 * 60 * 60 * 1000;

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

async function count(table: string): Promise<number> {
  const [row] = await database.sql`select count(*)::int as n from ${database.sql(table)}`;
  return Number(row?.n);
}

describe("revoking or blocking while an agent request is under way", () => {
  async function setUp() {
    const pause = pauseOnce();
    harness = createHarness(database, undefined, undefined, { beforeWrite: pause.hook });
    const browser = await fullAdmin(database, harness);
    const agent = await new TestAgent(harness).enroll(database);
    return { pause, browser, agent };
  }

  it("never writes a heartbeat after a revoke that already returned", async () => {
    const { pause, browser, agent } = await setUp();
    const heartbeat = agent.heartbeat();
    await pause.atPause; // authenticated, not yet written
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(200);
    pause.resume();
    expect(await heartbeat).toMatchObject({ status: 403, body: { error: "agent_revoked" } });
    expect(await count("heartbeat")).toBe(0);
    expect(await count("sync_anchor")).toBe(0);
  });

  it("never writes events after a block of the agent that already returned", async () => {
    const { pause, browser, agent } = await setUp();
    const events = agent.events([agent.event("resume", null)]);
    await pause.atPause;
    const blocked = await browser.post(`/api/admin/agents/${agent.agentId}`, {
      trustTier: "blocked",
    });
    expect(blocked.status).toBe(200);
    pause.resume();
    expect(await events).toMatchObject({ status: 403, body: { error: "agent_blocked" } });
    expect(await count("agent_event")).toBe(0);
  });

  it("never writes after a blocked range that already returned", async () => {
    const { pause, browser, agent } = await setUp();
    const heartbeat = agent.heartbeat();
    await pause.atPause;
    const added = await browser.post("/api/admin/blocked-ranges", { range: "203.0.113.0/24" });
    expect(added.status).toBe(201);
    pause.resume();
    expect(await heartbeat).toMatchObject({ status: 403, body: { error: "address_blocked" } });
    expect(await count("heartbeat")).toBe(0);
  });
});

describe("sync anchors and retention", () => {
  it("keeps the latest anchor of a boot past retention, so a long offline boot places its events", async () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    const agent = await new TestAgent(harness).enroll(database);
    harness.now = new Date(now.getTime() - 20 * DAY);
    await agent.heartbeat();
    harness.now = new Date(now.getTime() - 15 * DAY);
    await agent.heartbeat();
    const lastSync = agent.syncId;
    await database.sql`insert into setting (key, value, updated_by)
      values ('retention_days', '8'::jsonb, 'shlomi')`;

    const result = await runRetention(database.db, now);
    expect(result).toMatchObject({ heartbeats: 2, anchors: 1, complete: true });
    const anchors = await database.sql`select sync_id from sync_anchor`;
    expect(anchors.map((row) => row.sync_id)).toEqual([lastSync]);

    // Fifteen days later, still in the same boot, the agent reports an event of a minute ago.
    harness.now = now;
    const reply = await agent.events([agent.event("connectivity_restored", 15 * DAY - 60_000)]);
    expect(reply.body.results).toMatchObject([{ status: "accepted", timeUncertain: false }]);
  });
});

describe("IPv4-mapped addresses", () => {
  it.each(["::ffff:203.0.113.5", "::ffff:cb00:7105"])(
    "treats the peer %s as 203.0.113.5",
    async (peer) => {
      const agent = await new TestAgent(harness, peer).enroll(database);
      await agent.heartbeat();
      const [row] = await database.sql`select host(address) as address, site_key from agent`;
      expect(row).toEqual({ address: "203.0.113.5", site_key: "203.0.113.5" });
    },
  );

  it("stores a mapped block as IPv4, so it matches the normalized address", async () => {
    const browser = await fullAdmin(database, harness);
    const single = await browser.post("/api/admin/blocked-ranges", {
      range: "::ffff:203.0.113.5/128",
    });
    expect(single.body.range).toBe("203.0.113.5/32");
    const range = await browser.post("/api/admin/blocked-ranges", {
      range: "::ffff:cb00:7100/120",
    });
    expect(range.body.range).toBe("203.0.113.0/24");
    expect(
      (await new TestAgent(harness, "::ffff:cb00:7105").register(await insertKey(database))).body
        .error,
    ).toBe("address_blocked");
    expect(
      (await new TestAgent(harness, "203.0.113.9").register(await insertKey(database))).body.error,
    ).toBe("address_blocked");
  });
});

describe("settings updated at the same time", () => {
  it("audits every change when two updates race", async () => {
    const pause = pauseOnce();
    harness = createHarness(database, undefined, undefined, { afterSettingsRead: pause.hook });
    const browser = await fullAdmin(database, harness);
    // B reads 60 and stops; A then sets 120.
    const b = browser.post("/api/admin/settings", { heartbeatIntervalSeconds: 60 });
    await pause.atPause;
    const a = browser.post("/api/admin/settings", { heartbeatIntervalSeconds: 120 });
    // With the lock A waits for B; without it A finishes first.
    await Promise.race([a, untilLockWaiter(database.sql)]);
    pause.resume();
    expect((await b).status).toBe(200);
    expect((await a).status).toBe(200);

    const [stored] = await database.sql`select value from setting
      where key = 'heartbeat_interval_seconds'`;
    const audits = await database.sql`select details from audit_log
      where action = 'settings.updated' order by id`;
    const last = audits.at(-1)?.details as
      | { changes: { heartbeatIntervalSeconds: { to: number } } }
      | undefined;
    // The stored value is the one the last audited change set.
    expect(Number(stored?.value)).toBe(last?.changes.heartbeatIntervalSeconds.to ?? 60);
  });
});

describe("32-bit ASNs", () => {
  it("stores and maps an ASN above 2^31", async () => {
    const browser = await fullAdmin(database, harness);
    const created = await browser.post("/api/admin/providers", {
      name: "Private 32-bit",
      asns: [4200000001],
    });
    expect(created).toMatchObject({ status: 201, body: { asns: [4200000001] } });
    harness.asn.table.set("203.0.113.", { asn: 4200000001, organization: "Big ASN" });
    const agent = await new TestAgent(harness).enroll(database);
    expect((await agent.heartbeat()).status).toBe(200);
    expect((await browser.get("/api/admin/agents")).body.agents).toMatchObject([
      { asn: 4200000001, providerName: "Private 32-bit" },
    ]);
  });
});

describe("rate limits of unknown tokens", () => {
  it("limits unknown tokens by address with one limiter entry, and never blocks a real agent there", async () => {
    const agent = await new TestAgent(harness, "203.0.113.20").enroll(database);
    const stranger = new TestAgent(harness, "203.0.113.20");
    let last: Awaited<ReturnType<TestAgent["heartbeat"]>> | undefined;
    for (let i = 0; i < UNKNOWN_TOKEN_RATE_LIMIT.max + 5; i++) {
      stranger.token = randomBytes(32).toString("base64url");
      last = await stranger.heartbeat();
    }
    expect(last).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    // One entry for the address, not one per token.
    expect(harness.agentRateLimits.size).toBe(1);
    // The enrolled agent at the same address is limited by its own ID.
    expect((await agent.heartbeat()).status).toBe(200);
    expect(harness.agentRateLimits.size).toBe(2);
    // Registration has its own limiter.
    expect((await new TestAgent(harness, "203.0.113.20").register("x".repeat(32))).status).toBe(
      403,
    );
    expect(harness.registerRateLimits.size).toBe(1);
  });

  it("prunes expired entries from the oldest end without scanning the whole map", async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now);
    for (let i = 0; i < 100_000; i++) {
      await store.consume(`old:${i}`, { window: 60, max: 5 });
    }
    expect(store.size).toBe(100_000);
    now = 61_000;
    await store.consume("new", { window: 60, max: 5 });
    expect(store.size).toBe(1);
    // A key whose window restarted moves to the young end and survives pruning.
    await store.consume("new", { window: 60, max: 5 });
    expect(store.size).toBe(1);
  });
});
