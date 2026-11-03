import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTER_PRE_LIMIT_MIN } from "../src/agent/routes.js";
import { hashToken } from "../src/http/token-hash.js";
import { cachedSettings, invalidateSettingsCache, resetSettingsCache } from "../src/settings.js";
import { setSetting, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness, pauseOnce } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

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

async function agentRows() {
  return database.sql`select id, install_id, token_hash, label, trust_tier, agent_version,
    os_version, revoked_at from agent order by registered_at`;
}

describe("register (open registration)", () => {
  it("creates the agent at the tier for new agents, stores only the token hash, and writes no audit entry", async () => {
    const agent = new TestAgent(harness);
    const reply = await agent.register();
    expect(reply.status).toBe(201);
    expect(reply.headers.get("mashkif-protocol-version")).toBe("1");
    expect(reply.body).toMatchObject({ heartbeatIntervalSeconds: 60 });
    expect(Date.parse(String(reply.body.serverTime))).not.toBeNaN();

    const [row] = await agentRows();
    expect(row).toMatchObject({
      id: reply.body.agentId,
      install_id: agent.installId,
      token_hash: hashToken(agent.token),
      label: null,
      trust_tier: "low",
      agent_version: "0.1.0",
      os_version: "10.0.26100",
    });
    const dump = await database.sql`select row_to_json(a)::text as json from agent a`;
    expect(dump[0]?.json).not.toContain(agent.token);
    expect(await database.sql`select 1 from audit_log`).toHaveLength(0);
  });

  it("starts new agents at the tier the admin set", async () => {
    await setSetting(database, "new_agent_tier", "normal");
    expect((await new TestAgent(harness).register()).status).toBe(201);
    expect((await agentRows())[0]?.trust_tier).toBe("normal");
  });

  it("answers a repeat of the same registration with the same agent", async () => {
    const agent = new TestAgent(harness);
    const first = await agent.register();
    expect(first.status).toBe(201);
    const again = await agent.register();
    expect(again).toMatchObject({ status: 200, body: { agentId: first.body.agentId } });
    expect(await agentRows()).toHaveLength(1);
  });

  it("answers a repeat of a revoked identity with agent_revoked", async () => {
    const agent = new TestAgent(harness);
    expect((await agent.register()).status).toBe(201);
    await database.sql`update agent set revoked_at = now()`;
    expect(await agent.register()).toMatchObject({ status: 403, body: { error: "agent_revoked" } });
  });

  it("registers a PC that joins again after a revoke as a new low agent, keeping the revoked row", async () => {
    const old = new TestAgent(harness);
    await old.enroll();
    await database.sql`update agent set revoked_at = now()`;
    const rejoined = new TestAgent(harness);
    expect((await rejoined.register()).status).toBe(201);
    const rows = await agentRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      install_id: rejoined.installId,
      trust_tier: "low",
      revoked_at: null,
    });
  });

  it("refuses the install ID of an agent with another token, revoked or not", async () => {
    const first = new TestAgent(harness);
    await first.enroll();
    const second = new TestAgent(harness);
    second.installId = first.installId;
    expect(await second.register()).toMatchObject({
      status: 409,
      body: { error: "install_id_conflict" },
    });
    await database.sql`update agent set revoked_at = now()`;
    expect((await second.register()).body.error).toBe("install_id_conflict");
    expect(await agentRows()).toHaveLength(1);
  });

  it("refuses a token that another install ID uses", async () => {
    const first = new TestAgent(harness);
    await first.enroll();
    const second = new TestAgent(harness);
    second.token = first.token;
    expect((await second.register()).body.error).toBe("install_id_conflict");
  });

  describe("concurrency", () => {
    it("answers two identical requests at once with one 201 and one 200", async () => {
      const agent = new TestAgent(harness);
      const [a, b] = await Promise.all([agent.register(), agent.register()]);
      expect([a?.status, b?.status].sort()).toEqual([200, 201]);
      expect(a?.body.agentId).toBe(b?.body.agentId);
      expect(await agentRows()).toHaveLength(1);
    });

    it("gives one install ID to one of two tokens racing for it", async () => {
      const a = new TestAgent(harness);
      const b = new TestAgent(harness);
      b.installId = a.installId;
      const replies = await Promise.all([a.register(), b.register()]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
      expect(await agentRows()).toHaveLength(1);
    });

    it("gives one token to one of two install IDs racing for it", async () => {
      const a = new TestAgent(harness);
      const b = new TestAgent(harness);
      b.token = a.token;
      const replies = await Promise.all([a.register(), b.register()]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
      expect(await agentRows()).toHaveLength(1);
    });

    it("classifies a conflict again: a loser with another token gets 409 even when the winner was revoked meanwhile", async () => {
      const pause = pauseOnce();
      harness = createHarness(database, { registerHooks: { beforeInsert: pause.hook } });
      const loser = new TestAgent(harness);
      const winner = new TestAgent(harness);
      winner.installId = loser.installId;
      const loserReply = loser.register();
      await pause.atPause;
      expect((await winner.register()).status).toBe(201);
      await database.sql`update agent set revoked_at = now()`;
      pause.resume();
      expect(await loserReply).toMatchObject({
        status: 409,
        body: { error: "install_id_conflict" },
      });
      // The winner's own retry sees its revoke.
      expect((await winner.register()).body.error).toBe("agent_revoked");
      expect(await agentRows()).toHaveLength(1);
    });

    it("answers a repeat that lost the race to a now revoked copy of itself with agent_revoked", async () => {
      const pause = pauseOnce();
      harness = createHarness(database, { registerHooks: { beforeInsert: pause.hook } });
      const agent = new TestAgent(harness);
      const twin = new TestAgent(harness);
      twin.installId = agent.installId;
      twin.token = agent.token;
      const first = agent.register();
      await pause.atPause;
      expect((await twin.register()).status).toBe(201);
      await database.sql`update agent set revoked_at = now()`;
      pause.resume();
      expect(await first).toMatchObject({ status: 403, body: { error: "agent_revoked" } });
      expect(await agentRows()).toHaveLength(1);
    });
  });

  describe("registration switch and limits", () => {
    it("refuses new agents while registration is closed, and still answers existing ones", async () => {
      const existing = new TestAgent(harness);
      await existing.enroll();
      await setSetting(database, "registration_open", false);

      expect(await new TestAgent(harness).register()).toMatchObject({
        status: 403,
        body: { error: "registration_closed" },
      });
      expect((await existing.register()).status).toBe(200);
      expect((await existing.heartbeat()).status).toBe(200);
      expect(await agentRows()).toHaveLength(1);
    });

    it("limits new registrations per site, with the addresses of one IPv6 /64 sharing the limit", async () => {
      await setSetting(database, "register_per_site_per_10min", 2);
      const replies = [];
      for (const host of ["1", "2", "3"]) {
        replies.push(await new TestAgent(harness, `2001:db8:0:1::${host}`).register());
      }
      expect(replies.map((reply) => reply.status)).toEqual([201, 201, 429]);
      expect(replies[2]?.body.error).toBe("rate_limited");
      expect(Number(replies[2]?.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another /64 has its own limit.
      expect((await new TestAgent(harness, "2001:db8:0:2::1").register()).status).toBe(201);
    });

    it("limits new registrations across all sites, and never limits a repeat", async () => {
      await setSetting(database, "register_global_per_hour", 2);
      const first = new TestAgent(harness, "203.0.113.1");
      expect((await first.register()).status).toBe(201);
      expect((await new TestAgent(harness, "203.0.113.2").register()).status).toBe(201);
      const third = await new TestAgent(harness, "198.51.100.3").register();
      expect(third).toMatchObject({ status: 429, body: { error: "rate_limited" } });
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
      // The global limit is used up, but the same registration again passes.
      expect((await first.register()).status).toBe(200);
      expect(await agentRows()).toHaveLength(2);
    });

    it("never counts a repeat of an existing registration against the per-site limit", async () => {
      await setSetting(database, "register_per_site_per_10min", 1);
      const first = new TestAgent(harness, "203.0.113.40");
      expect((await first.register()).status).toBe(201);
      // The answer was lost: the same request again, several times.
      for (let i = 0; i < 3; i++) {
        expect((await first.register()).status).toBe(200);
      }
      // The site's only creation is used, by the first registration alone.
      expect((await new TestAgent(harness, "203.0.113.40").register()).status).toBe(429);
    });

    it("lets retries in a shared office leave the other installs their quota", async () => {
      await setSetting(database, "register_per_site_per_10min", 2);
      const first = new TestAgent(harness, "203.0.113.41");
      expect((await first.register()).status).toBe(201);
      for (let i = 0; i < 5; i++) {
        expect((await first.register()).status).toBe(200);
      }
      expect((await new TestAgent(harness, "203.0.113.41").register()).status).toBe(201);
      expect((await new TestAgent(harness, "203.0.113.41").register()).status).toBe(429);
    });

    it("lets a raised per-site limit through the pre-limit, which is max(60, that limit) a minute", async () => {
      await setSetting(database, "register_per_site_per_10min", 1000);
      // An admitted registration loads the settings; the pre-limit then uses them.
      expect((await new TestAgent(harness, "203.0.113.50").register()).status).toBe(201);
      const office = new TestAgent(harness, "203.0.113.50");
      const statuses = new Set<number>();
      for (let i = 0; i < REGISTER_PRE_LIMIT_MIN + 40; i++) {
        statuses.add((await office.post("/register", {})).status);
      }
      expect([...statuses]).toEqual([400]);
      // With the default per-site limit the pre-limit stays at 60 a minute.
      await setSetting(database, "register_per_site_per_10min", 10);
      const other = new TestAgent(harness, "203.0.113.51");
      expect((await other.register()).status).toBe(201);
      for (let i = 1; i < REGISTER_PRE_LIMIT_MIN; i++) {
        expect((await other.post("/register", {})).status).toBe(400);
      }
      expect((await other.post("/register", {})).status).toBe(429);
    });

    it("uses the minimum before the first load of the settings, as after a start", async () => {
      // A cold cache: a raised per-site limit in the database is not known yet.
      await setSetting(database, "register_per_site_per_10min", 1000);
      resetSettingsCache();
      const cold = new TestAgent(harness, "203.0.113.52");
      for (let i = 0; i < REGISTER_PRE_LIMIT_MIN; i++) {
        expect((await cold.post("/register", {})).status).toBe(400);
      }
      expect((await cold.post("/register", {})).status).toBe(429);
    });

    it("never queries for a limited site, also while the cache is expired and many requests arrive", async () => {
      expect((await new TestAgent(harness, "198.51.100.70").register()).status).toBe(201);
      const site = "2001:db8:a::";
      for (let i = 0; i < REGISTER_PRE_LIMIT_MIN; i++) {
        expect((await new TestAgent(harness, `${site}1`).post("/register", {})).status).toBe(400);
      }
      // The cache expires (a save or the TTL); the blocked site keeps sending.
      invalidateSettingsCache();
      const transaction = vi.spyOn(database.db, "transaction");
      const select = vi.spyOn(database.db, "select");
      try {
        const replies = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            new TestAgent(harness, `${site}${i + 2}`).register(),
          ),
        );
        expect(replies.map((reply) => reply.status)).toEqual(new Array(20).fill(429));
        expect(select).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
        select.mockRestore();
      }
    });

    it("keeps limiting with the last loaded settings when a refresh fails", async () => {
      const office = new TestAgent(harness, "203.0.113.53");
      expect((await office.register()).status).toBe(201);
      invalidateSettingsCache();
      const select = vi.spyOn(database.db, "select").mockImplementation(() => {
        throw new Error("database unavailable");
      });
      try {
        // The refresh fails; the request is answered from the last loaded settings.
        expect((await office.register()).status).toBe(200);
        expect(select).toHaveBeenCalled();
      } finally {
        select.mockRestore();
      }
      for (let i = 2; i < REGISTER_PRE_LIMIT_MIN; i++) {
        expect((await office.post("/register", {})).status).toBe(400);
      }
      expect((await office.post("/register", {})).status).toBe(429);
    });

    it("shares one refresh query among concurrent callers", async () => {
      await cachedSettings(database.db);
      invalidateSettingsCache();
      const select = vi.spyOn(database.db, "select");
      try {
        await Promise.all(Array.from({ length: 10 }, () => cachedSettings(database.db)));
        expect(select).toHaveBeenCalledTimes(1);
      } finally {
        select.mockRestore();
      }
    });

    it("gives the creation quota back when a racing copy of the registration created the agent", async () => {
      await setSetting(database, "register_per_site_per_10min", 2);
      const pause = pauseOnce();
      harness = createHarness(database, { registerHooks: { beforeInsert: pause.hook } });
      const agent = new TestAgent(harness, "203.0.113.60");
      const twin = new TestAgent(harness, "203.0.113.60");
      twin.installId = agent.installId;
      twin.token = agent.token;
      // The first copy counts its quota and waits before its insert; the
      // second creates the agent; the first then conflicts and answers 200.
      const first = agent.register();
      await pause.atPause;
      const second = await twin.register();
      pause.resume();
      expect([(await first).status, second.status].sort()).toEqual([200, 201]);
      // Only the real creation used quota: a different PC still fits.
      expect((await new TestAgent(harness, "203.0.113.60").register()).status).toBe(201);
      expect((await new TestAgent(harness, "203.0.113.60").register()).status).toBe(429);
    });

    it("refuses a flood from one site before any database work", async () => {
      const flood = new TestAgent(harness, "2001:db8:9::1");
      for (let i = 0; i < REGISTER_PRE_LIMIT_MIN; i++) {
        // Bodies that fail parsing: counted, but cheap.
        expect((await flood.post("/register", {})).status).toBe(400);
      }
      const transaction = vi.spyOn(database.db, "transaction");
      const select = vi.spyOn(database.db, "select");
      try {
        // Another address of the same IPv6 /64, with a valid registration.
        const limited = await new TestAgent(harness, "2001:db8:9::2").register();
        expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(transaction).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
        select.mockRestore();
      }
      expect(await agentRows()).toHaveLength(0);
    });

    it("refuses registration from a blocked address or range", async () => {
      await database.sql`insert into blocked_range (range, created_by) values ('203.0.113.0/24', 'shlomi')`;
      const reply = await new TestAgent(harness, "203.0.113.9").register();
      expect(reply).toMatchObject({ status: 403, body: { error: "address_blocked" } });
      expect(await agentRows()).toHaveLength(0);
    });
  });

  describe("request validation", () => {
    it.each([
      ["installId", { installId: "not-a-uuid" }],
      ["token", { token: "too-short" }],
      ["agentVersion", { agentVersion: "" }],
      ["osVersion", { osVersion: "<script>" }],
    ])("refuses an invalid %s", async (field, overrides) => {
      const reply = await new TestAgent(harness).register(overrides);
      expect(reply).toMatchObject({ status: 400, body: { error: "request_invalid", field } });
    });

    it("ignores an enrollment key that an older request may still carry", async () => {
      const reply = await new TestAgent(harness).register({ enrollmentKey: "x".repeat(32) });
      expect(reply.status).toBe(201);
    });

    it("refuses a body that is not JSON", async () => {
      const reply = await new TestAgent(harness).post("/register", "{not json");
      expect(reply).toMatchObject({
        status: 400,
        body: { error: "request_invalid", field: "body" },
      });
    });

    it("refuses a body over 64 KB", async () => {
      const reply = await new TestAgent(harness).register({ padding: "x".repeat(70 * 1024) });
      expect(reply).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
      expect(reply.headers.get("mashkif-protocol-version")).toBe("1");
    });

    it("needs the protocol version header", async () => {
      const reply = await new TestAgent(harness).post(
        "/register",
        {},
        { "mashkif-protocol-version": "" },
      );
      expect(reply).toMatchObject({ status: 400, body: { error: "protocol_version_missing" } });
    });
  });
});
