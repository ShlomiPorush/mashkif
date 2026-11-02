import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.js";
import { parseSettingsUpdate, readSettings } from "../src/settings.js";
import { setSetting, TestAgent } from "./support/agent.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import { createHarness, type Harness, pauseOnce } from "./support/harness.js";

let database: TestDatabase;
let harness: Harness;

const NOW = new Date("2026-11-01T12:00:00.000Z");
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

/** One agent with a heartbeat and an event on each of the given days before NOW. */
async function seed(daysAgo: number[]): Promise<void> {
  const agent = await new TestAgent(harness).enroll();
  for (const days of daysAgo) {
    harness.now = new Date(NOW.getTime() - days * DAY);
    expect((await agent.heartbeat()).status).toBe(200);
    expect((await agent.events([agent.event("sleep", 1000)])).status).toBe(200);
  }
}

async function counts() {
  const [row] = await database.sql`select
    (select count(*)::int from heartbeat) as heartbeats,
    (select count(*)::int from agent_event) as events,
    (select count(*)::int from agent) as agents`;
  return row;
}

describe("retention", () => {
  it("deletes raw heartbeats and events older than the setting, in batches, and keeps the rest", async () => {
    await seed([40, 35, 31, 29, 2]);
    const result = await runRetention(database.db, NOW, 2);
    expect(result).toMatchObject({ heartbeats: 3, events: 3, complete: true });
    expect(result.cutoff.toISOString()).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(await counts()).toEqual({ heartbeats: 2, events: 2, agents: 1 });
  });

  it("continues where an interrupted run stopped", async () => {
    await seed([50, 45, 40, 35, 1]);
    // One batch of one row per table, then the run stops as if interrupted.
    const partial = await runRetention(database.db, NOW, 1, 1);
    expect(partial).toMatchObject({ heartbeats: 1, events: 1, complete: false });
    expect(await counts()).toMatchObject({ heartbeats: 4, events: 4 });

    const rest = await runRetention(database.db, NOW, 1, 100);
    expect(rest).toMatchObject({ heartbeats: 3, events: 3, complete: true });
    expect(await counts()).toMatchObject({ heartbeats: 1, events: 1 });
  });

  it("follows the admin setting, which cannot go below 8 days", async () => {
    await seed([12, 9, 7]);
    await database.sql`insert into setting (key, value, updated_by)
      values ('retention_days', '8'::jsonb, 'shlomi')`;
    await runRetention(database.db, NOW);
    expect(await counts()).toMatchObject({ heartbeats: 1, events: 1 });

    expect(parseSettingsUpdate({ retentionDays: 7 }, [])).toEqual({
      ok: false,
      field: "retentionDays",
      locked: false,
    });
    // A value stored out of range falls back to the default instead of deleting too much.
    await database.sql`update setting set value = '1'::jsonb where key = 'retention_days'`;
    expect((await readSettings(database.db)).retentionDays).toBe(30);
  });

  it("does nothing when nothing is old", async () => {
    await seed([1]);
    expect(await runRetention(database.db, NOW)).toMatchObject({
      heartbeats: 0,
      events: 0,
      complete: true,
    });
  });
});

describe("cleanup of agents that never reported", () => {
  /** An agent registered the given number of days before NOW, without a heartbeat. */
  async function registered(daysAgo: number): Promise<TestAgent> {
    harness.now = new Date(NOW.getTime() - daysAgo * DAY);
    const agent = await new TestAgent(harness).enroll();
    harness.now = undefined;
    return agent;
  }

  async function exists(agent: TestAgent): Promise<boolean> {
    const rows = await database.sql`select 1 from agent where id = ${agent.agentId ?? ""}`;
    return rows.length === 1;
  }

  it("deletes only agents that are not revoked, never sent a heartbeat, and are older than the setting", async () => {
    const stale = await registered(31);
    const recent = await registered(29);
    const reported = await registered(40);
    harness.now = new Date(NOW.getTime() - 39 * DAY);
    expect((await reported.heartbeat()).status).toBe(200);
    harness.now = undefined;
    const revoked = await registered(400);
    await database.sql`update agent set revoked_at = now() where id = ${revoked.agentId ?? ""}`;

    const result = await runRetention(database.db, NOW);
    expect(result.agents).toBe(1);
    expect(await exists(stale)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(reported)).toBe(true);
    // Revoked rows stay forever: they make the server answer agent_revoked.
    expect(await exists(revoked)).toBe(true);
  });

  it("follows the setting and resumes in batches", async () => {
    await setSetting(database, "agent_cleanup_days", 7);
    await registered(8);
    await registered(9);
    await registered(10);
    const partial = await runRetention(database.db, NOW, 1, 2);
    expect(partial).toMatchObject({ agents: 2, complete: false });
    const rest = await runRetention(database.db, NOW, 1, 2);
    expect(rest).toMatchObject({ agents: 1, complete: true });
    expect(await counts()).toMatchObject({ agents: 0 });
  });

  it("keeps a revoked agent's row while its raw data ages out, so a PC that returns is told it was revoked", async () => {
    harness.now = new Date(NOW.getTime() - 60 * DAY);
    const agent = await new TestAgent(harness).enroll();
    expect((await agent.heartbeat()).status).toBe(200);
    // Revoked while the PC was offline.
    await database.sql`update agent set revoked_at = ${new Date(NOW.getTime() - 50 * DAY).toISOString()}::timestamptz`;
    await runRetention(database.db, NOW);
    expect(await counts()).toMatchObject({ heartbeats: 0, agents: 1 });

    harness.now = NOW;
    expect(await agent.heartbeat()).toMatchObject({
      status: 403,
      body: { error: "agent_revoked" },
    });
    // Its own registration again is refused the same way; it does not register anew.
    expect((await agent.register()).body.error).toBe("agent_revoked");
    expect(await counts()).toMatchObject({ agents: 1 });
  });

  it("keeps an agent whose first heartbeat holds its row while the cleanup runs", async () => {
    const agent = await registered(40);
    const heartbeat = await database.sql.reserve();
    try {
      await heartbeat`begin`;
      await heartbeat`select id from agent where id = ${agent.agentId ?? ""} for update`;
      expect((await runRetention(database.db, NOW)).agents).toBe(0);
      await heartbeat`update agent set last_seen_at = now() where id = ${agent.agentId ?? ""}`;
      await heartbeat`commit`;
    } finally {
      heartbeat.release();
    }
    expect((await runRetention(database.db, NOW)).agents).toBe(0);
    expect(await exists(agent)).toBe(true);
  });

  it.each(["heartbeat", "events"] as const)(
    "answers a %s request whose agent the cleanup removed after authentication with 401, and the agent registers again",
    async (kind) => {
      const pause = pauseOnce();
      harness = createHarness(database, { beforeWrite: pause.hook });
      const agent = await registered(40);
      const reply =
        kind === "heartbeat" ? agent.heartbeat() : agent.events([agent.event("sleep", null)]);
      await pause.atPause;
      expect((await runRetention(database.db, NOW)).agents).toBe(1);
      pause.resume();
      expect(await reply).toMatchObject({ status: 401, body: { error: "token_invalid" } });

      // The 401 cycle: a new token with the same install ID.
      agent.token = randomBytes(32).toString("base64url");
      expect((await agent.register()).status).toBe(201);
    },
  );

  it.each(["heartbeat", "events"] as const)(
    "still answers a %s request of an agent revoked after authentication with agent_revoked",
    async (kind) => {
      const pause = pauseOnce();
      harness = createHarness(database, { beforeWrite: pause.hook });
      const agent = await new TestAgent(harness).enroll();
      const reply =
        kind === "heartbeat" ? agent.heartbeat() : agent.events([agent.event("sleep", null)]);
      await pause.atPause;
      await database.sql`update agent set revoked_at = now()`;
      pause.resume();
      expect(await reply).toMatchObject({ status: 403, body: { error: "agent_revoked" } });
    },
  );
});
