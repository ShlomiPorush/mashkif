import { latLngToCell } from "h3-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_RATE_LIMIT } from "../src/agent/routes.js";
import { TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const TEL_AVIV = latLngToCell(32.08, 34.78, 7);
const PARIS = latLngToCell(48.85, 2.35, 7);

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

async function agentRow(id: string | undefined) {
  const [row] = await database.sql`select host(address) as address, site_key, asn, as_organization,
    reported_cell, infrastructure, interval_reported_seconds, interval_sent_seconds,
    silence_interval_seconds, last_seen_at, last_sequence, agent_version
    from agent where id = ${id ?? ""}`;
  return row;
}

async function setInterval(seconds: number) {
  await database.sql`insert into setting (key, value, updated_by)
    values ('heartbeat_interval_seconds', ${String(seconds)}::jsonb, 'shlomi')
    on conflict (key) do update set value = excluded.value`;
}

describe("heartbeat", () => {
  it("records the heartbeat and answers with a sync ID, the server time, and the interval", async () => {
    harness.asn.table.set("203.0.113.", { asn: 64500, organization: "Example Net" });
    const agent = await new TestAgent(harness).enroll(database);
    harness.now = new Date("2026-11-01T10:00:00.000Z");
    const reply = await agent.heartbeat({
      areaCell: TEL_AVIV,
      infrastructure: "bezeq",
      agentVersion: "0.1.1",
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      syncId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      serverTime: "2026-11-01T10:00:00.000Z",
      nextIntervalSeconds: 60,
    });
    const [stored] = await database.sql`select sync_id, received_at, host(address) as address,
      site_key, asn, area_cell, infrastructure, round_trip_ms, dns_ms, interval_reported_seconds,
      interval_sent_seconds from heartbeat`;
    expect(stored).toMatchObject({
      sync_id: reply.body.syncId,
      address: "203.0.113.5",
      site_key: "203.0.113.5",
      asn: 64500,
      area_cell: TEL_AVIV,
      infrastructure: "bezeq",
      round_trip_ms: 40,
      dns_ms: 5,
      interval_reported_seconds: 60,
      interval_sent_seconds: 60,
    });
    expect(await agentRow(agent.agentId)).toMatchObject({
      address: "203.0.113.5",
      asn: 64500,
      as_organization: "Example Net",
      reported_cell: TEL_AVIV,
      infrastructure: "bezeq",
      silence_interval_seconds: 60,
      agent_version: "0.1.1",
    });
  });

  it("stores a retry of the same heartbeat once and answers it the same way (lost response)", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    const first = await agent.heartbeat({}, { lose: true });
    // The agent never saw the answer and sends the same heartbeat again.
    const retry = await agent.post("/heartbeat", agent.heartbeatBody());
    expect(retry).toMatchObject({ status: 200, body: first.body });
    expect(await database.sql`select 1 from heartbeat`).toHaveLength(1);
    // The next heartbeat is new.
    const next = await agent.heartbeat();
    expect(next.body.syncId).not.toBe(first.body.syncId);
    expect(await database.sql`select 1 from heartbeat`).toHaveLength(2);
  });

  it.each([
    ["increase", 60, 120],
    ["decrease", 60, 30],
  ])(
    "judges silence by the larger interval after an %s whose response was lost",
    async (_, from, to) => {
      const agent = await new TestAgent(harness).enroll(database);
      await agent.heartbeat();
      expect(agent.interval).toBe(from);

      await setInterval(to);
      // The server sends the new interval; the answer is lost.
      const lost = await agent.heartbeat({}, { lose: true });
      expect(lost.body.nextIntervalSeconds).toBe(to);
      expect(await agentRow(agent.agentId)).toMatchObject({
        interval_reported_seconds: from,
        interval_sent_seconds: to,
        silence_interval_seconds: Math.max(from, to),
      });

      // Still on the old interval, the agent sends again and now gets the answer.
      await agent.heartbeat();
      expect(agent.interval).toBe(to);
      expect((await agentRow(agent.agentId))?.silence_interval_seconds).toBe(Math.max(from, to));

      // Once it reports the new interval, that one counts.
      await agent.heartbeat();
      expect(await agentRow(agent.agentId)).toMatchObject({
        interval_reported_seconds: to,
        silence_interval_seconds: to,
      });
    },
  );

  it("puts IPv6 addresses of one /64 on one site, and moves the agent when its address changes", async () => {
    const agent = await new TestAgent(harness, "2001:db8:1:2::10").enroll(database);
    await agent.heartbeat();
    expect(await agentRow(agent.agentId)).toMatchObject({
      address: "2001:db8:1:2::10",
      site_key: "2001:db8:1:2::/64",
    });

    agent.address = "2001:db8:1:2:aaaa:bbbb:cccc:dddd";
    await agent.heartbeat();
    expect((await agentRow(agent.agentId))?.site_key).toBe("2001:db8:1:2::/64");

    agent.address = "2001:db8:1:3::10";
    await agent.heartbeat();
    expect((await agentRow(agent.agentId))?.site_key).toBe("2001:db8:1:3::/64");

    agent.address = "198.51.100.20";
    await agent.heartbeat();
    expect(await agentRow(agent.agentId)).toMatchObject({
      address: "198.51.100.20",
      site_key: "198.51.100.20",
    });
    const sites = await database.sql`select site_key from heartbeat order by id`;
    expect(sites.map((row) => row.site_key)).toEqual([
      "2001:db8:1:2::/64",
      "2001:db8:1:2::/64",
      "2001:db8:1:3::/64",
      "198.51.100.20",
    ]);
  });

  it("treats an IPv4-mapped peer address as IPv4", async () => {
    const agent = await new TestAgent(harness, "::ffff:198.51.100.30").enroll(database);
    await agent.heartbeat();
    expect((await agentRow(agent.agentId))?.site_key).toBe("198.51.100.30");
  });

  it("stores a cell outside the service area as unknown and refuses a cell that is not resolution 7", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    expect((await agent.heartbeat({ areaCell: PARIS })).status).toBe(200);
    expect((await agentRow(agent.agentId))?.reported_cell).toBeNull();

    for (const cell of [latLngToCell(32.08, 34.78, 8), "8f2830828052d25", "not-a-cell"]) {
      const reply = await agent.heartbeat({ areaCell: cell });
      expect(reply).toMatchObject({
        status: 400,
        body: { error: "request_invalid", field: "areaCell" },
      });
    }
  });

  it("stores an infrastructure it does not know yet as unknown", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    expect((await agent.heartbeat({ infrastructure: "future_fiber" })).status).toBe(200);
    expect((await agentRow(agent.agentId))?.infrastructure).toBe("unknown");
  });

  it.each([
    ["sequence", { sequence: -1 }],
    ["bootId", { bootId: "nope" }],
    ["intervalSeconds", { intervalSeconds: 0 }],
    ["roundTripMs", { roundTripMs: 1.5 }],
    ["dnsMs", { dnsMs: "5" as unknown as number }],
  ])("refuses an invalid %s", async (field, overrides) => {
    const agent = await new TestAgent(harness).enroll(database);
    const reply = await agent.post("/heartbeat", agent.heartbeatBody(overrides));
    expect(reply).toMatchObject({ status: 400, body: { error: "request_invalid", field } });
  });

  it("refuses a missing, malformed, unknown, or revoked token", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    expect(
      (await agent.post("/heartbeat", agent.heartbeatBody(), { authorization: "" })).body.error,
    ).toBe("token_invalid");
    expect(
      (await agent.post("/heartbeat", agent.heartbeatBody(), { authorization: "Bearer abc" }))
        .status,
    ).toBe(401);
    const stranger = new TestAgent(harness);
    expect(await stranger.heartbeat()).toMatchObject({
      status: 401,
      body: { error: "token_invalid" },
    });

    await database.sql`update agent set revoked_at = now()`;
    expect(await agent.heartbeat()).toMatchObject({
      status: 403,
      body: { error: "agent_revoked" },
    });
    expect(await database.sql`select 1 from heartbeat`).toHaveLength(0);
  });

  it("refuses a blocked agent and a blocked address without storing anything", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    await database.sql`update agent set trust_tier = 'blocked'`;
    expect(await agent.heartbeat()).toMatchObject({
      status: 403,
      body: { error: "agent_blocked" },
    });

    await database.sql`update agent set trust_tier = 'suspicious'`;
    expect((await agent.heartbeat()).status).toBe(200);

    await database.sql`insert into blocked_range (range, created_by) values ('203.0.113.5/32', 'shlomi')`;
    expect(await agent.heartbeat()).toMatchObject({
      status: 403,
      body: { error: "address_blocked" },
    });

    await database.sql`delete from blocked_range`;
    await database.sql`insert into blocked_range (range, created_by) values ('2001:db8::/32', 'shlomi')`;
    agent.address = "2001:db8:ffff::1";
    expect((await agent.heartbeat()).body.error).toBe("address_blocked");
    expect(await database.sql`select 1 from heartbeat`).toHaveLength(1);
  });

  it("limits heartbeats per token with 429 and Retry-After", async () => {
    const agent = await new TestAgent(harness).enroll(database);
    const other = await new TestAgent(harness).enroll(database);
    let last: Awaited<ReturnType<TestAgent["heartbeat"]>> | undefined;
    for (let i = 0; i < HEARTBEAT_RATE_LIMIT.max + 1; i++) {
      last = await agent.heartbeat();
    }
    expect(last?.status).toBe(429);
    expect(last?.body.error).toBe("rate_limited");
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    // The limit is per token, so the same address with another token goes on.
    expect((await other.heartbeat()).status).toBe(200);
  });
});

describe("client address", () => {
  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    harness = createHarness(database, undefined, undefined, { trustedProxies: ["10.0.0.0/8"] });
    const agent = await new TestAgent(harness, "203.0.113.5").enroll(database);
    await agent.post("/heartbeat", agent.heartbeatBody({ sequence: 1 }), {
      "x-forwarded-for": "198.51.100.99",
    });
    expect((await agentRow(agent.agentId))?.address).toBe("203.0.113.5");
  });

  it("takes the right-most untrusted address behind a trusted proxy, ignoring what the client wrote", async () => {
    harness = createHarness(database, undefined, undefined, { trustedProxies: ["10.0.0.0/8"] });
    const agent = await new TestAgent(harness, "10.0.0.2").enroll(database);
    // The client wrote 192.0.2.1 itself; the proxy appended the real address.
    await agent.post("/heartbeat", agent.heartbeatBody({ sequence: 1 }), {
      "x-forwarded-for": "192.0.2.1, 198.51.100.40",
    });
    expect((await agentRow(agent.agentId))?.address).toBe("198.51.100.40");
  });

  it("limits sign-in by the resolved address, so a forged header does not reset the count", async () => {
    harness = createHarness(database, undefined, undefined, { trustedProxies: ["10.0.0.0/8"] });
    const attempt = (forwarded: string) =>
      harness.app.request("https://admin.test/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          origin: "https://admin.test",
          "content-type": "application/json",
          "x-test-client": "203.0.113.50",
          "x-forwarded-for": forwarded,
        },
        body: JSON.stringify({ username: "nobody", password: "wrong password!" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await attempt(`192.0.2.${i}`)).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});
