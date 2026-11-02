import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDRESS_RATE_LIMIT, INVALID_TOKEN_COST } from "../src/agent/routes.js";
import { MAX_SYNC_ANCHORS_PER_AGENT } from "../src/db/schema.js";
import { MemoryRateLimitStore } from "../src/http/rate-limit.js";
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
    harness = createHarness(database, { beforeWrite: pause.hook });
    const browser = await fullAdmin(harness);
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

describe("sync anchors", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  async function retainEightDays() {
    await database.sql`insert into setting (key, value, updated_by)
      values ('retention_days', '8'::jsonb, 'shlomi')`;
  }

  async function anchorIds(): Promise<string[]> {
    const rows = await database.sql`select sync_id from sync_anchor order by id`;
    return rows.map((row) => String(row.sync_id));
  }

  /** Older anchors of an agent, inserted directly, as K heartbeats would have made them. */
  async function insertAnchors(agent: TestAgent, n: number, at: Date) {
    await database.sql`insert into sync_anchor (sync_id, agent_id, boot_id, server_time)
      select 'filler-' || g, ${agent.agentId ?? ""}, ${agent.bootId}, ${at.toISOString()}::timestamptz
      from generate_series(1, ${n}) g`;
  }

  it(`keeps the newest ${MAX_SYNC_ANCHORS_PER_AGENT} anchors of an agent, evicting at insert`, async () => {
    const agent = await new TestAgent(harness).enroll(database);
    await insertAnchors(agent, MAX_SYNC_ANCHORS_PER_AGENT, ago(1));
    const other = await new TestAgent(harness).enroll(database);
    await other.heartbeat();
    const reply = await agent.heartbeat();
    const ids =
      await database.sql`select sync_id from sync_anchor where agent_id = ${agent.agentId ?? ""}
      order by id`;
    expect(ids).toHaveLength(MAX_SYNC_ANCHORS_PER_AGENT);
    expect(ids[0]?.sync_id).toBe("filler-2");
    expect(ids.at(-1)?.sync_id).toBe(reply.body.syncId);
    // Another agent's anchors are untouched.
    expect(
      await database.sql`select 1 from sync_anchor where agent_id = ${other.agentId ?? ""}`,
    ).toHaveLength(1);
  });

  it("places events after an offline period longer than retention, also for the review scenarios", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    harness.now = ago(20);
    await agent.heartbeat();
    harness.now = ago(19);
    // A later answer that was lost: the agent keeps the one it received.
    await agent.heartbeat({}, { lose: true });
    const held = agent.syncId as string;
    // Back online, the reconnect heartbeat comes before the backlog.
    harness.now = new Date(now.getTime() - 60_000);
    await agent.heartbeat({}, { lose: true });
    await retainEightDays();
    await runRetention(database.db, now);
    expect(await anchorIds()).toContain(held);

    harness.now = now;
    agent.syncId = held;
    const reply = await agent.events([agent.event("connectivity_restored", 20 * DAY - 120_000)]);
    expect(reply.body.results).toMatchObject([{ status: "accepted", timeUncertain: false }]);
  });

  it(`marks an event time uncertain once more than ${MAX_SYNC_ANCHORS_PER_AGENT} newer anchors exist`, async () => {
    const agent = await new TestAgent(harness).enroll(database);
    harness.now = ago(2);
    await agent.heartbeat();
    const held = agent.syncId as string;
    await insertAnchors(agent, MAX_SYNC_ANCHORS_PER_AGENT - 1, ago(1));
    harness.now = now;
    await agent.heartbeat({}, { lose: true }); // the K-th newer anchor evicts the held one
    expect(await anchorIds()).not.toContain(held);
    agent.syncId = held;
    const reply = await agent.events([agent.event("sleep", DAY)]);
    expect(reply.body.results).toMatchObject([{ status: "accepted", timeUncertain: true }]);
    const [row] = await database.sql`select uncertain_reason from agent_event`;
    expect(row?.uncertain_reason).toBe("sync_unknown");
  });

  it("never loses a just-returned anchor to retention running at the same time", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    await database.sql`insert into setting (key, value, updated_by)
      values ('retention_days', '8'::jsonb, 'shlomi')`;
    harness.now = now;
    const [, reply] = await Promise.all([
      runRetention(database.db, new Date(now.getTime() + 365 * DAY)),
      agent.heartbeat(),
    ]);
    await runRetention(database.db, new Date(now.getTime() + 365 * DAY));
    expect(await anchorIds()).toEqual([reply.body.syncId]);
  });
});

describe("boot counters", () => {
  async function bootRows(): Promise<string[]> {
    const rows = await database.sql`select boot_id from agent_boot order by created_at`;
    return rows.map((row) => String(row.boot_id));
  }

  it("keeps at most 10 boot counters per agent, never evicting the current boot", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    const start = Date.parse("2026-11-01T08:00:00.000Z");
    harness.now = new Date(start);
    await agent.heartbeat();
    const current = agent.bootId;
    // The current boot's counter is the oldest row.
    await agent.events([], { bootId: current, count: 1 });
    // Counters of eleven historical boots arrive later.
    const historical: string[] = [];
    for (let i = 1; i <= 11; i++) {
      historical.push(randomUUID());
      harness.now = new Date(start + i * 60_000);
      harness.agentRateLimits.clear(); // not what this test is about
      await agent.events([], { bootId: historical.at(-1) as string, count: i });
    }
    const rows = await bootRows();
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(current);
    expect(rows.slice(1)).toEqual(historical.slice(2));
  });

  it("protects the current boot when its counter arrives after 10 historical ones", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    await agent.heartbeat(); // the current boot, no counter row yet
    for (let i = 0; i < 10; i++) {
      await agent.events([], { bootId: randomUUID(), count: 1 });
    }
    await agent.events([], { bootId: agent.bootId, count: 2 });
    const rows = await bootRows();
    expect(rows).toHaveLength(10);
    expect(rows).toContain(agent.bootId);
  });

  it("deletes the anchors and boot counters of a revoked agent", async () => {
    const browser = await fullAdmin(harness);
    const agent = await new TestAgent(harness).enroll(database);
    await agent.heartbeat();
    await agent.events([], { bootId: agent.bootId, count: 4 });
    expect(await count("agent_boot")).toBe(1);
    expect((await browser.post(`/api/admin/agents/${agent.agentId}/revoke`)).status).toBe(200);
    expect(await count("agent_boot")).toBe(0);
    expect(await count("sync_anchor")).toBe(0);
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
    const browser = await fullAdmin(harness);
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
    harness = createHarness(database, { afterSettingsRead: pause.hook });
    const browser = await fullAdmin(harness);
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
    const browser = await fullAdmin(harness);
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

describe("rate limits before the token lookup", () => {
  it("stops a repeated bogus token from reaching the database", async () => {
    const stranger = new TestAgent(harness, "203.0.113.20");
    const select = vi.spyOn(database.db, "select");
    const statuses: number[] = [];
    const lookups: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await stranger.heartbeat()).status);
      lookups.push(select.mock.calls.length);
    }
    const limit = ADDRESS_RATE_LIMIT.max / INVALID_TOKEN_COST;
    expect(statuses.slice(0, limit)).toEqual(new Array(limit).fill(401));
    expect(statuses.slice(limit)).toEqual(new Array(25 - limit).fill(429));
    // Once the address is limited, no request queries the database.
    expect(lookups.slice(limit - 1).every((n) => n === lookups[limit - 1])).toBe(true);
    expect(lookups[limit - 1]).toBe(limit);
    // One limiter entry, for the address.
    expect(harness.agentRateLimits.size).toBe(1);
    select.mockRestore();
  });

  it("lets an office of agents behind one address through, each limited by its own ID", async () => {
    const office = [
      await new TestAgent(harness, "203.0.113.30").enroll(database),
      await new TestAgent(harness, "203.0.113.30").enroll(database),
    ];
    for (const agent of office) {
      expect((await agent.heartbeat()).status).toBe(200);
    }
    // One entry for the address and one per agent; another address is untouched.
    expect(harness.agentRateLimits.size).toBe(3);
    const elsewhere = await new TestAgent(harness, "203.0.113.31").enroll(database);
    expect((await elsewhere.heartbeat()).status).toBe(200);
    // Registration has its own limiter.
    expect((await new TestAgent(harness, "203.0.113.30").register("x".repeat(32))).status).toBe(
      403,
    );
    expect(harness.registerRateLimits.size).toBe(2);
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
    await store.consume("new", { window: 60, max: 5 });
    expect(store.size).toBe(1);
  });
});
